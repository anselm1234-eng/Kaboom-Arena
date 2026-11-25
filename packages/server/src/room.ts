import {
  AFK_KICK_MS,
  AFK_WARNING_MS,
  BOT_FILL_TARGET,
  BOT_FINALE_COUNTDOWN_MS,
  BOT_FINALE_PLAYON_MS,
  DEFAULT_ROOM_SIZE_DESKTOP,
  MAX_LOCAL_PLAYERS,
  PREMATCH_COUNTDOWN_MS,
  READY_TIMEOUT_MS,
  RECONNECT_GRACE_MS,
  ROOM_MIN_PLAYERS,
  ROUND_END_MS,
  TICK_MS,
  gridToString,
  type BotDifficulty,
  type RoomSize,
  type RoomState,
  type ServerMessage,
  type SkinChoice,
} from '@blastmates/shared';
import { BOT_NAMES, BotController } from './bot';
import { selectBricks, type BrickCandidate } from './bricks';
import { Game, type BrickRoundStats, type SuddenDeathConfig } from './game';
import { randomToken } from './ids';

/** Upper bound on simulation sub-steps per tick, so a hitch can't burst. */
const MAX_SUBSTEPS = 8;

/** Transport abstraction so rooms can be tested without real sockets. */
export interface ClientConn {
  send(msg: ServerMessage): void;
}

export interface RosterPlayer {
  id: string;
  token: string;
  nickname: string;
  skin: SkinChoice | undefined;
  conn: ClientConn | null;
  connected: boolean;
  bot: boolean;
  /** Primary player id of the connection this local player shares, else null. */
  ownerId: string | null;
  spectator: boolean;
  /** Ready-check state; bots are always ready. */
  ready: boolean;
  /** Bot added automatically to pad out a public start; removed after the match. */
  autoFill: boolean;
  wins: number;
  joinedAt: number;
  disconnectedAt: number | null;
  /** Last gameplay input (move/bomb) seen by the server; reset at round start. */
  lastInputAt: number | null;
  /** An AFK warning is showing on this player's screen. */
  afkWarned: boolean;
}

export class RoomError extends Error {
  constructor(
    readonly code:
      | 'room_full'
      | 'cannot_start'
      | 'not_host'
      | 'no_such_bot'
      | 'not_allowed',
    message: string,
  ) {
    super(message);
  }
}

export interface AfkConfig {
  warningMs?: number;
  kickMs?: number;
}

export interface PublicStartConfig {
  /** Anti-stall timer: force-start this long after the first human readies up. */
  readyTimeoutMs?: number;
  /** Bot fill: pad a sub-2-player start up to this many participants. */
  botFillTarget?: number;
}

export interface RoomOptions {
  rng?: () => number;
  /** Room size (player cap); map dimensions derive from it. */
  size?: RoomSize;
  /** Display name shown in lobbies and the room browser. */
  name?: string;
  onEmpty?: (room: Room) => void;
  /** Active branded bricks eligible for placement (public rooms only). */
  brickCandidates?: () => BrickCandidate[];
  /** Called at round end with per-brick stats for batched persistence. */
  onBrickStats?: (stats: Map<string, BrickRoundStats>) => void;
  /** Sudden-death tuning for this room's matches (defaults in shared constants). */
  suddenDeath?: SuddenDeathConfig;
  /** AFK warning/kick tuning (defaults in shared constants). */
  afk?: AfkConfig;
  /** Public ready-start tuning (defaults in shared constants). */
  publicStart?: PublicStartConfig;
}

export class Room {
  state: RoomState = 'lobby';
  readonly name: string;
  readonly roster = new Map<string, RosterPlayer>();
  game: Game | null = null;
  /** Private rooms only; public rooms are hostless. */
  hostId: string | null = null;
  winnerId: string | null = null;
  /** Pre-match countdown deadline or round-end deadline, depending on state. */
  deadline: number | null = null;
  /** Public anti-stall timer: force-start deadline, armed by the first ready-up. */
  readyDeadline: number | null = null;

  private tickCount = 0;
  private lastTickAt: number | null = null;
  /**
   * Virtual simulation clock, tracking wall time. All game state and snapshots
   * are stamped with this clock so it stays self-consistent.
   */
  private gameClock = 0;
  /**
   * Bot-only endgame: server time at which the round is force-resolved once no
   * humans are left alive. Null until the finale is armed (and reset per round).
   */
  private botFinaleAt: number | null = null;
  /**
   * Bricks are constant for a round, so they ride only on keyframe snapshots.
   * Armed at round start and whenever a connection (re)joins a live match, so
   * a fresh client always gets the brick set before it has to render it;
   * cleared by the next snapshot that carries them.
   */
  private keyframePending = false;
  private nextPlayerNum = 1;
  private readonly botControllers = new Map<string, BotController>();
  private readonly rng: () => number;
  private readonly onEmpty: (room: Room) => void;
  private readonly brickCandidates: () => BrickCandidate[];
  private readonly onBrickStats: (stats: Map<string, BrickRoundStats>) => void;
  private readonly suddenDeath: SuddenDeathConfig | undefined;
  private readonly afkWarningMs: number;
  private readonly afkKickMs: number;
  private readonly readyTimeoutMs: number;
  private readonly botFillTarget: number;
  /** Bots already reported as stuck this round (logged once, never kicked). */
  private readonly stuckBotsLogged = new Set<string>();
  /** Player cap. Public rooms: fixed at creation. Private: host-resizable in lobby. */
  private size: RoomSize;

  constructor(
    readonly id: string,
    readonly isPrivate: boolean,
    private readonly password: string | undefined,
    opts: RoomOptions = {},
  ) {
    this.rng = opts.rng ?? Math.random;
    this.size = opts.size ?? DEFAULT_ROOM_SIZE_DESKTOP;
    this.name = opts.name ?? `ROOM ${id.toUpperCase()}`;
    this.onEmpty = opts.onEmpty ?? (() => {});
    this.brickCandidates = opts.brickCandidates ?? (() => []);
    this.onBrickStats = opts.onBrickStats ?? (() => {});
    this.suddenDeath = opts.suddenDeath;
    this.afkWarningMs = opts.afk?.warningMs ?? AFK_WARNING_MS;
    this.afkKickMs = opts.afk?.kickMs ?? AFK_KICK_MS;
    this.readyTimeoutMs = opts.publicStart?.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.botFillTarget = opts.publicStart?.botFillTarget ?? BOT_FILL_TARGET;
  }

  get maxPlayers(): number {
    return this.size;
  }

  /**
   * Resize a private room between matches (host only, lobby only). Public
   * rooms are hostless with equal rights: their size is fixed at creation.
   * The new size can never go below the current participant count
   * (humans + bots, including disconnected players still holding a slot).
   */
  setSize(requesterId: string, size: RoomSize, now: number): void {
    if (!this.isPrivate) {
      throw new RoomError('not_allowed', 'Public room size is fixed');
    }
    if (!this.isHostConnection(requesterId)) {
      throw new RoomError('not_host', 'Only the host can change the room size');
    }
    if (this.state !== 'lobby') {
      throw new RoomError('cannot_start', 'Room size can only change between matches');
    }
    if (this.roster.size > size) {
      throw new RoomError(
        'not_allowed',
        `${this.roster.size} players are in the room - remove some first`,
      );
    }
    if (this.size === size) return;
    this.size = size;
    this.broadcastRoom(now);
  }

  hasPassword(): boolean {
    return this.password !== undefined;
  }

  checkPassword(pw: string | undefined): boolean {
    return this.password === undefined || this.password === pw;
  }

  hasSlot(): boolean {
    return this.roster.size < this.maxPlayers;
  }

  /** A human can get in: free slot, or (public lobby) a bot to displace. */
  joinable(): boolean {
    if (this.hasSlot()) return true;
    if (this.isPrivate || (this.state !== 'lobby' && this.state !== 'countdown')) return false;
    return [...this.roster.values()].some((p) => p.bot);
  }

  connectedPlayers(): RosterPlayer[] {
    return [...this.roster.values()].filter((p) => p.connected);
  }

  /** Players eligible to fight next round (connected, in join order). */
  private eligiblePlayers(): RosterPlayer[] {
    return this.connectedPlayers().sort((a, b) => a.joinedAt - b.joinedAt);
  }

  addPlayer(nickname: string, conn: ClientConn, now: number, skin?: SkinChoice): RosterPlayer {
    if (!this.hasSlot() && !this.displaceBot()) throw new RoomError('room_full', 'Room is full');
    const player: RosterPlayer = {
      id: `p${this.id}-${this.nextPlayerNum++}`,
      token: randomToken(),
      nickname,
      skin,
      conn,
      connected: true,
      bot: false,
      ownerId: null,
      spectator: this.state === 'playing' || this.state === 'roundEnd',
      ready: false,
      autoFill: false,
      wins: 0,
      joinedAt: now,
      disconnectedAt: null,
      lastInputAt: null,
      afkWarned: false,
    };
    this.roster.set(player.id, player);
    // A mid-match joiner spectates the live board and needs the brick set in
    // the next snapshot it receives.
    if (this.game) this.keyframePending = true;
    this.ensureHost();
    this.cancelCountdownOnJoin();
    this.broadcastRoom(now);
    return player;
  }

  /**
   * Public rooms: a human joining a full room bumps a bot out. In the lobby
   * any bot makes way; mid-match only fill bots do (they die out of the
   * running round), so manually added bots keep playing.
   */
  private displaceBot(): boolean {
    if (this.isPrivate) return false;
    const bots = [...this.roster.values()].filter((p) => p.bot);
    const inLobby = this.state === 'lobby' || this.state === 'countdown';
    const victim = bots.find((b) => b.autoFill) ?? (inLobby ? bots[bots.length - 1] : undefined);
    if (!victim) return false;
    this.botControllers.delete(victim.id);
    this.roster.delete(victim.id);
    this.game?.killPlayer(victim.id);
    return true;
  }

  /** New joiners arrive un-ready and get a moment: the pre-match countdown
   *  cancels (the anti-stall timer keeps running and may restart it). */
  private cancelCountdownOnJoin(): void {
    if (!this.isPrivate && this.state === 'countdown') {
      this.state = 'lobby';
      this.deadline = null;
    }
  }

  /** Extra local players sharing ownerId's connection/keyboard. */
  localPlayersOf(ownerId: string): RosterPlayer[] {
    return [...this.roster.values()]
      .filter((p) => p.ownerId === ownerId)
      .sort((a, b) => a.joinedAt - b.joinedAt);
  }

  /** The whole connection group: the primary (if present) plus its locals. */
  private connectionPlayers(ownerId: string): RosterPlayer[] {
    const owner = this.roster.get(ownerId);
    return owner ? [owner, ...this.localPlayersOf(ownerId)] : this.localPlayersOf(ownerId);
  }

  /** True if pid is the connection's own player (itself or one of its locals). */
  ownsPlayer(actorId: string, pid: string): boolean {
    return pid === actorId || this.roster.get(pid)?.ownerId === actorId;
  }

  /** True if a branded brick is currently placed in this room's live match. */
  hasPlacedBrick(id: string): boolean {
    return this.game?.placedBricks.some((b) => b.id === id) ?? false;
  }

  /** Add an extra local player to ownerId's connection (lobby only). */
  addLocalPlayer(ownerId: string, now: number, nickname?: string): RosterPlayer {
    const owner = this.roster.get(ownerId);
    if (!owner || owner.bot || owner.ownerId !== null) {
      throw new RoomError('not_allowed', 'No such player on this connection');
    }
    if (this.state !== 'lobby' && this.state !== 'countdown') {
      throw new RoomError('cannot_start', 'Local players can only be added in the lobby');
    }
    if (!this.hasSlot() && !this.displaceBot()) throw new RoomError('room_full', 'Room is full');
    const group = this.connectionPlayers(ownerId);
    if (group.length >= MAX_LOCAL_PLAYERS) {
      throw new RoomError('not_allowed', `Max ${MAX_LOCAL_PLAYERS} players per device`);
    }
    const player: RosterPlayer = {
      id: `p${this.id}-${this.nextPlayerNum++}`,
      token: randomToken(),
      nickname: nickname ?? `Player ${group.length + 1}`,
      skin: undefined,
      conn: owner.conn,
      connected: owner.connected,
      bot: false,
      ownerId,
      spectator: false,
      ready: false,
      autoFill: false,
      wins: 0,
      joinedAt: now,
      disconnectedAt: null,
      lastInputAt: null,
      afkWarned: false,
    };
    this.roster.set(player.id, player);
    this.cancelCountdownOnJoin();
    this.broadcastRoom(now);
    return player;
  }

  /** Remove one of the connection's own local players (lobby only). */
  removeLocalPlayer(ownerId: string, playerId: string, now: number): void {
    const target = this.roster.get(playerId);
    if (!target || target.ownerId !== ownerId) {
      throw new RoomError('not_allowed', 'No such local player on this connection');
    }
    if (this.state !== 'lobby' && this.state !== 'countdown') {
      throw new RoomError('cannot_start', 'Local players can only be removed in the lobby');
    }
    this.removePlayer(playerId, now);
  }

  /** Rename one of the connection's own local players (lobby only). */
  renameLocalPlayer(ownerId: string, playerId: string, nickname: string, now: number): void {
    const target = this.roster.get(playerId);
    if (!target || target.ownerId !== ownerId) {
      throw new RoomError('not_allowed', 'No such local player on this connection');
    }
    if (this.state !== 'lobby' && this.state !== 'countdown') {
      throw new RoomError('cannot_start', 'Local players can only be renamed in the lobby');
    }
    target.nickname = nickname;
    this.broadcastRoom(now);
  }

  /** Add a bot. Private rooms: host only. Public rooms: anyone. */
  addBot(requesterId: string, now: number, difficulty: BotDifficulty = 'normal'): RosterPlayer {
    this.assertBotControl(requesterId);
    if (this.state !== 'lobby' && this.state !== 'countdown') {
      throw new RoomError('cannot_start', 'Bots can only be added in the lobby');
    }
    if (!this.hasSlot()) throw new RoomError('room_full', 'Room is full');
    const player = this.spawnBot(now, difficulty, false);
    this.broadcastRoom(now);
    return player;
  }

  /**
   * Seed a freshly created lobby with bots so the host has opponents waiting.
   * Adds half the player cap (4→2, 6→3, 8→4), capped by the open slots, and
   * leaves the rest free for humans. No requester gate: called by the manager
   * on creation, before anyone has joined. Lobby-only.
   */
  fillInitialBots(now: number, difficulty: BotDifficulty = 'normal'): void {
    if (this.state !== 'lobby' && this.state !== 'countdown') return;
    const target = Math.floor(this.maxPlayers / 2);
    for (let i = 0; i < target && this.hasSlot(); i++) {
      this.spawnBot(now, difficulty, false);
    }
    this.broadcastRoom(now);
  }

  /** Remove a bot; mid-game this plays out like a disconnect. */
  removeBot(requesterId: string, botId: string, now: number): void {
    this.assertBotControl(requesterId);
    const target = this.roster.get(botId);
    if (!target || !target.bot) throw new RoomError('no_such_bot', 'No such bot in this room');
    this.botControllers.delete(botId);
    this.removePlayer(botId, now);
  }

  /**
   * Host kick (private rooms, lobby only). Kicking any player on a
   * connection removes the whole group: the primary player and every
   * local player sharing that keyboard leave together.
   */
  kickPlayer(requesterId: string, playerId: string, now: number): void {
    if (!this.isPrivate) {
      throw new RoomError('not_allowed', 'Public rooms have no host kick');
    }
    if (!this.isHostConnection(requesterId)) {
      throw new RoomError('not_host', 'Only the host can kick players');
    }
    if (this.state !== 'lobby') {
      throw new RoomError('cannot_start', 'Players can only be kicked in the lobby');
    }
    const target = this.roster.get(playerId);
    if (!target || target.bot) {
      throw new RoomError('not_allowed', 'No such player in this room');
    }
    const ownerId = target.ownerId ?? target.id;
    if (this.ownsPlayer(requesterId, ownerId)) {
      throw new RoomError('not_allowed', 'You cannot kick your own players');
    }
    // One message tells the whole connection it was kicked; locals share it.
    target.conn?.send({ t: 'kicked', reason: 'host', playerId: ownerId });
    this.removeConnection(ownerId, now);
  }

  /** Bot permission gate: host-only in private rooms, any player in public. */
  private assertBotControl(requesterId: string): void {
    if (this.isPrivate) {
      if (!this.isHostConnection(requesterId)) {
        throw new RoomError('not_host', 'Only the host can manage bots');
      }
      return;
    }
    const actor = this.roster.get(requesterId);
    if (!actor || actor.bot) throw new RoomError('not_allowed', 'Not a player in this room');
  }

  private spawnBot(now: number, difficulty: BotDifficulty, autoFill: boolean): RosterPlayer {
    const used = new Set([...this.roster.values()].map((p) => p.nickname));
    const names = BOT_NAMES.filter((n) => !used.has(n));
    const nickname = names[Math.floor(this.rng() * names.length)] ?? `Bot ${this.nextPlayerNum}`;
    const player: RosterPlayer = {
      id: `p${this.id}-${this.nextPlayerNum++}`,
      token: randomToken(),
      nickname,
      skin: undefined,
      conn: null,
      connected: true,
      bot: true,
      ownerId: null,
      spectator: false,
      ready: true,
      autoFill,
      wins: 0,
      joinedAt: now,
      disconnectedAt: null,
      lastInputAt: null,
      afkWarned: false,
    };
    this.roster.set(player.id, player);
    this.botControllers.set(player.id, new BotController(player.id, difficulty, this.rng));
    return player;
  }

  /** Reattach a player (and their local players) within the grace window. */
  rejoin(playerId: string, conn: ClientConn, now: number): RosterPlayer | null {
    const player = this.roster.get(playerId);
    if (!player || player.connected) return null;
    // A rejoiner's snapshot buffer is empty, so the next snapshot it sees must
    // carry the bricks again.
    if (this.game) this.keyframePending = true;
    for (const p of this.connectionPlayers(playerId)) {
      p.conn = conn;
      p.connected = true;
      p.disconnectedAt = null;
      // Disconnect handling owns the offline window; the AFK clock restarts fresh.
      p.lastInputAt = now;
      p.afkWarned = false;
      // Their old entity is dead; they spectate until the next round starts.
      if (this.state === 'playing' || this.state === 'roundEnd') p.spectator = true;
    }
    this.ensureHost();
    this.cancelCountdownOnJoin(); // rejoiners arrive un-ready, like fresh joiners
    this.broadcastRoom(now);
    return player;
  }

  /** Connection dropped: every player sharing it goes offline together. */
  handleDisconnect(playerId: string, now: number): void {
    const player = this.roster.get(playerId);
    if (!player || !player.connected) return;
    for (const p of this.connectionPlayers(playerId)) {
      p.conn = null;
      p.connected = false;
      p.disconnectedAt = now;
      p.ready = false; // a rejoin within the grace window arrives un-ready
      this.game?.killPlayer(p.id);
    }
    this.ensureHost();
    this.syncReadyTimer(now);
    this.broadcastRoom(now);
  }

  /** Explicit leave: removes the player and every local player they own. */
  removeConnection(ownerId: string, now: number): void {
    for (const p of this.localPlayersOf(ownerId)) this.removePlayer(p.id, now);
    this.removePlayer(ownerId, now);
  }

  /** Immediate leave: no reconnect grace. */
  removePlayer(playerId: string, now: number): void {
    const player = this.roster.get(playerId);
    if (!player) return;
    this.roster.delete(playerId);
    this.botControllers.delete(playerId);
    this.game?.killPlayer(playerId);
    this.ensureHost();
    if (!this.hasHumans()) {
      this.onEmpty(this);
      return;
    }
    this.syncReadyTimer(now);
    this.broadcastRoom(now);
  }

  /** Bots cannot keep a room alive on their own. */
  private hasHumans(): boolean {
    return [...this.roster.values()].some((p) => !p.bot);
  }

  /**
   * Private rooms: host is the earliest-joined connected human (host
   * migration). Public rooms are hostless - hostId stays null.
   */
  private ensureHost(): void {
    if (!this.isPrivate) return;
    const current = this.hostId ? this.roster.get(this.hostId) : undefined;
    if (!current || !current.connected) {
      const humans = this.eligiblePlayers().filter((p) => !p.bot);
      // Prefer primaries; a local player only hosts if no primary remains.
      this.hostId = (humans.find((p) => p.ownerId === null) ?? humans[0])?.id ?? null;
    }
  }

  /** Host check at connection granularity: a conn hosts if it owns the host. */
  private isHostConnection(requesterId: string): boolean {
    return this.hostId !== null && this.ownsPlayer(requesterId, this.hostId);
  }

  /** Manual start by the host (private rooms only). */
  startByHost(playerId: string, now: number): void {
    if (!this.isPrivate) {
      throw new RoomError('not_allowed', 'Public matches start when players are ready');
    }
    if (!this.isHostConnection(playerId)) throw new RoomError('not_host', 'Only the host can start');
    if (this.state !== 'lobby') throw new RoomError('cannot_start', 'Game already started');
    if (this.eligiblePlayers().length < ROOM_MIN_PLAYERS) {
      throw new RoomError('cannot_start', `Need at least ${ROOM_MIN_PLAYERS} players`);
    }
    // Same pre-match countdown as public rooms, so everyone sees it coming.
    this.state = 'countdown';
    this.deadline = now + PREMATCH_COUNTDOWN_MS;
    this.broadcastRoom(now);
  }

  /** Toggle ready on one of the connection's own human players (lobby only). */
  setReady(actorId: string, pid: string, ready: boolean, now: number): void {
    const target = this.roster.get(pid);
    if (!target || target.bot || !this.ownsPlayer(actorId, pid)) {
      throw new RoomError('not_allowed', 'You can only ready up your own players');
    }
    if (this.state !== 'lobby' && this.state !== 'countdown') {
      throw new RoomError('cannot_start', 'Ready can only change in the lobby');
    }
    if (target.ready === ready) return;
    target.ready = ready;
    this.syncReadyTimer(now);
    this.broadcastRoom(now);
  }

  /**
   * Public anti-stall timer: arms when the first human readies up, disarms
   * when the last ready human un-readies or leaves. Joins never touch it.
   */
  private syncReadyTimer(now: number): void {
    if (this.isPrivate) return;
    const anyReady = this.connectedPlayers().some((p) => !p.bot && p.ready);
    if (!anyReady) this.readyDeadline = null;
    else if (this.readyDeadline === null) this.readyDeadline = now + this.readyTimeoutMs;
  }

  /**
   * Public rooms: a start is due while every present human is ready (and the
   * match would have 2+ participants), or once the anti-stall timer expires
   * with at least one ready player. Evaluated continuously, so the pre-match
   * countdown cancels itself the moment its trigger no longer holds.
   */
  private publicStartDue(now: number): boolean {
    const humans = this.connectedPlayers().filter((p) => !p.bot);
    const ready = humans.filter((p) => p.ready);
    if (ready.length === 0) return false;
    const bots = [...this.roster.values()].filter((p) => p.bot).length;
    const allReady = ready.length === humans.length && ready.length + bots >= ROOM_MIN_PLAYERS;
    const timerDue = this.readyDeadline !== null && now >= this.readyDeadline;
    return allReady || timerDue;
  }

  /**
   * Public start: ready only gates the start trigger, never participation.
   * Once a start is due, every connected human fights (nobody is benched
   * into spectating for not pressing ready); bot fill pads a thin match.
   */
  private startPublicMatch(now: number): void {
    const participants = this.eligiblePlayers();
    if (participants.length < ROOM_MIN_PLAYERS) {
      const target = Math.min(this.botFillTarget, this.maxPlayers);
      while (participants.length < target && this.roster.size < this.maxPlayers) {
        participants.push(this.spawnBot(now, 'normal', true));
      }
    }
    this.startRound(now, participants);
  }

  /**
   * Public rooms chain rounds: the next one starts right after the round-end
   * banner, but only with 2+ real participants (humans, manual bots,
   * mid-round joiners). Fill bots never carry over - a player left alone
   * returns to the lobby instead of fighting conjured bots forever.
   */
  private startNextPublicRound(now: number): void {
    const eligible = this.eligiblePlayers();
    const core = eligible.filter((p) => !p.autoFill);
    if (core.length < ROOM_MIN_PLAYERS) {
      this.reassembleLobby(now);
      return;
    }
    for (const p of eligible) {
      if (!p.autoFill) continue;
      this.botControllers.delete(p.id);
      this.roster.delete(p.id);
    }
    this.startRound(now);
  }

  /**
   * Public rooms return to the lobby when rounds cannot chain: ready states
   * reset, the anti-stall timer disarms, and fill bots leave again.
   */
  private reassembleLobby(now: number): void {
    this.state = 'lobby';
    this.game = null;
    this.winnerId = null;
    this.deadline = null;
    this.readyDeadline = null;
    for (const p of [...this.roster.values()]) {
      p.ready = p.bot;
      if (p.bot && p.autoFill) {
        this.botControllers.delete(p.id);
        this.roster.delete(p.id);
      }
    }
    this.broadcastRoom(now);
  }

  handleInput(playerId: string, dir: Parameters<Game['setInput']>[1], now: number): void {
    this.noteActivity(playerId, now, dir !== null);
    this.game?.setInput(playerId, dir);
  }

  handleBomb(playerId: string, now: number): void {
    this.noteActivity(playerId, now, true);
    if (this.state === 'playing') this.game?.placeBomb(playerId, now);
  }

  /**
   * Humans send input messages only on real key/joystick changes, so any
   * message counts as activity (even a release, dir=null). Bots route a
   * decision through here every tick, so only real actions count for them.
   */
  private noteActivity(playerId: string, now: number, realAction: boolean): void {
    const player = this.roster.get(playerId);
    if (!player) return;
    if (player.bot && !realAction) return;
    player.lastInputAt = now;
    if (player.afkWarned) {
      player.afkWarned = false;
      player.conn?.send({ t: 'afk', playerId: player.id, kickAt: null });
    }
  }

  private startRound(now: number, fighters: RosterPlayer[] = this.eligiblePlayers()): void {
    const participants = fighters.slice(0, this.maxPlayers);
    for (const p of this.roster.values()) p.spectator = true;
    for (const p of participants) p.spectator = false;
    // Branded bricks appear in public matches only; private games stay clean.
    const bricks = this.isPrivate ? [] : selectBricks(this.brickCandidates(), this.rng);
    this.game = new Game(
      participants.map((p) => p.id),
      {
        rng: this.rng,
        size: this.size,
        bricks,
        ...(this.suddenDeath ? { suddenDeath: this.suddenDeath } : {}),
      },
    );
    for (const controller of this.botControllers.values()) controller.reset();
    // The AFK clock starts when the match goes live, never in lobby/countdown.
    for (const p of this.roster.values()) {
      p.lastInputAt = now;
      p.afkWarned = false;
    }
    this.stuckBotsLogged.clear();
    this.state = 'playing';
    this.winnerId = null;
    this.deadline = null;
    this.readyDeadline = null;
    this.lastTickAt = now;
    this.gameClock = now;
    this.botFinaleAt = null;
    this.keyframePending = true; // first snapshot of the round carries the bricks
    this.broadcastRoom(now);
  }

  tick(now: number): void {
    this.expireDisconnected(now);

    if (this.state === 'lobby') {
      // Public rooms start by ready check; private rooms wait for the host.
      if (!this.isPrivate && this.publicStartDue(now)) {
        this.state = 'countdown';
        this.deadline = now + PREMATCH_COUNTDOWN_MS;
        this.broadcastRoom(now);
      }
    } else if (this.state === 'countdown') {
      if (this.isPrivate) {
        // Host-started countdown; cancels itself if the room thins out.
        if (this.eligiblePlayers().length < ROOM_MIN_PLAYERS) {
          this.state = 'lobby';
          this.deadline = null;
          this.broadcastRoom(now);
        } else if (this.deadline !== null && now >= this.deadline) {
          this.startRound(now);
        }
      } else if (!this.publicStartDue(now)) {
        this.state = 'lobby';
        this.deadline = null;
        this.broadcastRoom(now);
      } else if (this.deadline !== null && now >= this.deadline) {
        this.startPublicMatch(now);
      }
    } else if (this.state === 'playing' && this.game) {
      const realDt = this.lastTickAt === null ? TICK_MS : now - this.lastTickAt;
      this.lastTickAt = now;
      // AFK is about real human idle time, so it stays on the wall clock and
      // runs once per real tick regardless of how the simulation is paced.
      this.checkAfk(now);

      // Bot-only endgame: once no humans are left alive, arm a short finale so
      // the dead players aren't left watching a slow real-time bot-vs-bot stall.
      // The bots keep fighting through a brief play-on plus a visible countdown
      // (snapshots carry botFinaleAt); when it elapses one survivor is crowned
      // and the rest are killed. If the bots settle it to a lone survivor first,
      // the round just ends normally in the sub-step loop below.
      const finale = this.noHumansAlive() && this.game.alivePlayers().length > 1;
      if (finale && this.botFinaleAt === null) {
        this.botFinaleAt = now + BOT_FINALE_PLAYON_MS + BOT_FINALE_COUNTDOWN_MS;
      } else if (!finale) {
        this.botFinaleAt = null;
      }

      if (this.botFinaleAt !== null && now >= this.botFinaleAt) {
        this.resolveBotFinale(now);
      } else {
        // Simulate the elapsed game-time in sub-steps no larger than one normal
        // tick, emitting a snapshot per sub-step. Capping the step keeps a
        // real-time hitch from tunnelling a player through a solid cell.
        let remaining = realDt;
        let steps = 0;
        while (remaining > 1e-3) {
          // Cap the sub-step count so a real-time hitch can't fan out into an
          // unbounded burst of snapshots; any leftover collapses into one step.
          const stepMs = steps + 1 >= MAX_SUBSTEPS ? remaining : Math.min(remaining, TICK_MS);
          remaining -= stepMs;
          steps++;
          if (this.advanceGame(now, stepMs)) break; // round resolved; stop early
        }
      }
    } else if (this.state === 'roundEnd') {
      if (this.deadline !== null && now >= this.deadline) {
        if (!this.isPrivate) {
          // Public rooms roll straight into the next round.
          this.startNextPublicRound(now);
        } else if (this.eligiblePlayers().length >= ROOM_MIN_PLAYERS) {
          this.startRound(now);
        } else {
          this.state = 'lobby';
          this.game = null;
          this.winnerId = null;
          this.deadline = null;
          for (const p of this.roster.values()) p.ready = p.bot;
          this.broadcastRoom(now);
        }
      }
    }
  }

  /**
   * Advance the simulation by one game-time sub-step: feed the bots, step the
   * game and broadcast a snapshot, all stamped with the virtual clock. The
   * movement integration is capped purely to stop a large step from tunnelling
   * a player through a solid cell. Returns true once the round has resolved, so
   * the caller's sub-step loop stops immediately.
   */
  private advanceGame(now: number, dtMs: number): boolean {
    const game = this.game;
    if (!game) return true;
    this.gameClock += dtMs;
    const clock = this.gameClock;
    // Bot decisions enter through the same handleInput/handleBomb entry points
    // that websocket messages use; the game loop sees no difference.
    for (const [botId, controller] of this.botControllers) {
      const decision = controller.update(game, clock);
      this.handleInput(botId, decision.dir, clock);
      if (decision.bomb) this.handleBomb(botId, clock);
    }
    game.update(clock, Math.min(dtMs, 250));
    this.broadcast(this.snapshotMessage(clock));
    return this.resolveRoundEnd(now);
  }

  /**
   * End the round when at most one fighter is left: credit the winner, switch
   * to the results state and arm the real-time inter-round pause. Returns true
   * when the round ended this call.
   */
  private resolveRoundEnd(now: number): boolean {
    const game = this.game;
    if (!game) return true;
    const alive = game.alivePlayers();
    if (alive.length > 1) return false;
    this.winnerId = alive[0]?.id ?? null;
    const winner = this.winnerId ? this.roster.get(this.winnerId) : undefined;
    if (winner) winner.wins += 1;
    this.state = 'roundEnd';
    this.deadline = now + ROUND_END_MS;
    const brickStats = game.brickRoundStats();
    if (brickStats.size > 0) this.onBrickStats(brickStats);
    this.broadcastRoom(now);
    return true;
  }

  /**
   * Bot-only finale countdown has elapsed: pick one of the surviving bots at
   * random to win, kill the rest and end the round. A final snapshot lets the
   * losers visibly die before the results screen, and resolveRoundEnd credits
   * the lone survivor. Caller guarantees >1 fighter alive.
   */
  private resolveBotFinale(now: number): boolean {
    const game = this.game;
    if (!game) return false;
    const survivors = game.alivePlayers();
    if (survivors.length <= 1) return false;
    const winner = survivors[Math.floor(this.rng() * survivors.length)] ?? survivors[0]!;
    for (const p of survivors) {
      if (p.id !== winner.id) game.killPlayer(p.id);
    }
    this.broadcast(this.snapshotMessage(this.gameClock));
    return this.resolveRoundEnd(now);
  }

  /**
   * True once a round is live with at least one fighter alive but none of the
   * survivors are human. Drives the bot-only fast-forward; returns false while
   * any human is still in the fight (and when nobody is left, which the
   * round-end check handles).
   */
  private noHumansAlive(): boolean {
    const game = this.game;
    if (!game) return false;
    const alive = game.alivePlayers();
    if (alive.length === 0) return false;
    return alive.every((p) => this.roster.get(p.id)?.bot === true);
  }

  /**
   * AFK detection: alive, connected, non-bot fighters only. Dead players
   * spectate idle as long as they like; disconnected players are owned by
   * the reconnect grace, not the AFK clock.
   */
  private checkAfk(now: number): void {
    const game = this.game;
    if (!game) return;
    for (const player of [...this.roster.values()]) {
      if (player.spectator) continue;
      const alive = game.players.get(player.id)?.alive === true;
      if (player.bot) {
        // Bots are never kicked; a stuck one is a bug worth logging once.
        if (
          alive &&
          player.lastInputAt !== null &&
          now - player.lastInputAt >= this.afkKickMs &&
          !this.stuckBotsLogged.has(player.id)
        ) {
          this.stuckBotsLogged.add(player.id);
          console.warn(`stuck bot ${player.nickname} (${player.id}) in room ${this.id}: no action for ${now - player.lastInputAt}ms`);
        }
        continue;
      }
      if (!alive) {
        if (player.afkWarned) {
          // Died while the warning was showing: clear it and stop the timer.
          player.afkWarned = false;
          player.conn?.send({ t: 'afk', playerId: player.id, kickAt: null });
        }
        continue;
      }
      if (!player.connected || player.lastInputAt === null) continue;
      const idleMs = now - player.lastInputAt;
      if (idleMs >= this.afkKickMs) {
        player.conn?.send({ t: 'kicked', reason: 'afk', playerId: player.id });
        this.removePlayer(player.id, now);
      } else if (idleMs >= this.afkWarningMs && !player.afkWarned) {
        player.afkWarned = true;
        player.conn?.send({
          t: 'afk',
          playerId: player.id,
          kickAt: player.lastInputAt + this.afkKickMs,
        });
      }
    }
  }

  private expireDisconnected(now: number): void {
    let changed = false;
    for (const player of [...this.roster.values()]) {
      if (
        !player.connected &&
        player.disconnectedAt !== null &&
        now - player.disconnectedAt >= RECONNECT_GRACE_MS
      ) {
        this.roster.delete(player.id);
        changed = true;
      }
    }
    if (changed) {
      this.ensureHost();
      if (!this.hasHumans()) {
        this.onEmpty(this);
        return;
      }
      this.syncReadyTimer(now);
      this.broadcastRoom(now);
    }
  }

  snapshotMessage(now: number): ServerMessage {
    const game = this.game;
    if (!game) throw new Error('no active game');
    // Bricks ride only on keyframes (see keyframePending); other ticks omit the
    // field entirely and the client reuses the last set it received.
    const includeBricks = this.keyframePending;
    this.keyframePending = false;
    return {
      t: 'snapshot',
      tick: this.tickCount++,
      serverTime: now,
      grid: gridToString(game.grid),
      players: game.playerSnapshots(),
      bombs: game.bombSnapshots(),
      explosions: game.explosionSnapshots(),
      powerups: game.powerupSnapshots(),
      ...(includeBricks ? { bricks: game.brickSnapshots() } : {}),
      ...(game.suddenDeathAt !== null ? { suddenDeathAt: game.suddenDeathAt } : {}),
      crush: game.crushWarnings(now),
      ...(this.botFinaleAt !== null ? { botFinaleAt: this.botFinaleAt } : {}),
    };
  }

  roomMessage(now: number): ServerMessage {
    return {
      t: 'room',
      roomId: this.id,
      roomName: this.name,
      state: this.state,
      isPrivate: this.isPrivate,
      hostId: this.hostId,
      maxPlayers: this.maxPlayers,
      countdownEndsAt: this.deadline,
      winnerId: this.winnerId,
      readyTimerEndsAt: this.readyDeadline,
      serverTime: now,
      players: [...this.roster.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => ({
          id: p.id,
          nickname: p.nickname,
          connected: p.connected,
          spectator: p.spectator,
          ready: p.ready,
          wins: p.wins,
          ...(p.skin ? { skin: p.skin } : {}),
          ...(p.bot ? { bot: true } : {}),
          ...(p.ownerId !== null ? { ownerId: p.ownerId } : {}),
        })),
    };
  }

  broadcastRoom(now: number): void {
    this.broadcast(this.roomMessage(now));
  }

  private broadcast(msg: ServerMessage): void {
    // Local players share their owner's socket: send once per connection.
    const seen = new Set<ClientConn>();
    for (const player of this.roster.values()) {
      if (!player.conn || seen.has(player.conn)) continue;
      seen.add(player.conn);
      player.conn.send(msg);
    }
  }
}
