import {
  BOT_FINALE_COUNTDOWN_MS,
  RECONNECT_GRACE_MS,
  ROOM_MAX_PLAYERS,
  ROOM_MIN_PLAYERS,
  ROOM_SIZE_GRID,
  isFreeSkin,
  roomSizeFor,
  type JoinMode,
  type JoinedMessage,
  type RoomMessage,
  type RoomSize,
  type ServerMessage,
} from '@blastmates/shared';
import { ensureAccount, setResetToken, setVerifyNotice } from './account';
import { maybeStartDemo } from './demo';
import { fetchRoomInfo, funNickname, pruneRecentRoom, rememberRoom, type RoomPreview } from './rooms';
import { effectiveSkin } from './skins';
import { Fx } from './fx';
import { HapticEvents, Haptics } from './haptics';
import { audio } from './sound';
import { SoundEvents } from './soundEvents';
import { InputManager } from './input';
import { layoutFor, type PadPreset } from './keymaps';
import { Net } from './net';
import { TouchControls, isTouchDevice } from './touch';
import { Renderer, playerColorCss, type BannerState, type BrickHit } from './render';
import { SnapshotBuffer } from './snapshots';
import { HUD_ICONS } from './icons';

export type ScreenName =
  | 'landing'
  | 'join'
  | 'lobby'
  | 'game'
  | 'removed'
  | 'skins'
  | 'settings'
  | 'account';

/** Standalone pages reachable from the landing screen, with their own URLs. */
const PAGE_PATHS = { skins: '/skins', settings: '/settings', account: '/account' } as const;
type PageName = keyof typeof PAGE_PATHS;

export interface JoinView {
  roomId: string;
  /** null = still looking the room up. */
  preview: RoomPreview | null;
  /** Dead-end card (room gone / full / unreachable) instead of the form. */
  edge: { title: string; msg: string } | null;
  /** Password row forced visible by a password_required/bad_password error. */
  forcePassword: boolean;
  error: string;
  /** Bumped whenever the password input should grab focus again. */
  passwordFocusNonce: number;
}

export interface ControlsFlashLine {
  text: string;
  /** CSS color for the leading label (player rows only). */
  color?: string;
  /** Uncolored suffix after the label (the key preset). */
  suffix?: string;
}

interface StoredSession {
  token: string;
  roomId: string;
  nickname: string;
}

/**
 * All client session state and game wiring, ported from the old imperative
 * main.ts. React screens subscribe via useSyncExternalStore and render from
 * the public fields; the canvas, virtual touch pad and input routing stay
 * imperative behind attachGame().
 */
export class GameSession {
  // --- Engine layer (game itself stays canvas + classes, not React) ---
  readonly buffer = new SnapshotBuffer();
  readonly fx = new Fx();
  readonly input = new InputManager();
  readonly isTouch = isTouchDevice();
  readonly haptics = new Haptics(this.isTouch);
  readonly hapticEvents = new HapticEvents(this.haptics);
  readonly soundEvents = new SoundEvents();
  readonly placeholderNickname = funNickname();

  private net: Net | null = null;
  private renderer: Renderer | null = null;
  private touchControls: TouchControls | null = null;
  private hudEl: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private insetProbe: HTMLDivElement | null = null;

  // --- Observable state ---
  screen: ScreenName = 'landing';
  joined: JoinedMessage | null = null;
  room: RoomMessage | null = null;
  reconnecting = false;
  /** Connect/join in flight: PLAY/CREATE/JOIN buttons disable. */
  joining = false;
  landingError = '';
  /** Server-error notice shown in the lobby status line until the next room update. */
  lobbyNotice: string | null = null;
  joinView: JoinView | null = null;
  menu: 'closed' | 'main' | 'confirm' = 'closed';
  controlsFlash: ControlsFlashLine[] | null = null;
  nickname = localStorage.getItem('nickname') ?? '';
  demoMode = false;

  roundStartAt: number | null = null;
  /** Server time when the last of this device's fighters died this round. */
  myDeathAt: number | null = null;
  demoBanner: BannerState | null = null;
  /**
   * Players controlled from this device, in pad-slot order ([0] = primary).
   * Mid-match the list stays positionally frozen so pads keep their bindings;
   * it is reconciled against the roster (and layouts re-mapped) in the lobby.
   */
  localIds: string[] = [];
  /** Mine that the server removed mid-match (AFK kick); pads stay but go dead. */
  private readonly removedLocalIds = new Set<string>();
  /** Active key presets, index = pad slot; kept in sync with localIds. */
  currentPresets: readonly PadPreset[] = layoutFor(1);
  /** Per-player AFK warnings: playerId -> server time of the kick. */
  readonly afkWarnings = new Map<string, number>();
  /** Why this device landed on the removed screen. */
  removedReason: 'afk' | 'host' = 'afk';

  private arenaMaxPlayers = 0;
  private pendingGrid: { width: number; height: number } | null = null;
  private controlsFlashTimer: number | null = null;
  private readonly portraitQuery = window.matchMedia('(orientation: portrait)');

  // --- Subscription (useSyncExternalStore) ---

  private version = 0;
  private readonly listeners = new Set<() => void>();

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const cb of this.listeners) cb();
  }

  constructor() {
    // Each pad drives exactly one of this connection's players; pid is always
    // explicit so routing survives even if the primary was removed mid-match.
    this.input.onDirChange = (slot, dir) => {
      const pid = this.localIds[slot] ?? this.joined?.playerId;
      if (pid) this.net?.send({ t: 'input', dir, pid });
    };
    this.input.onBomb = (slot) => {
      const pid = this.localIds[slot] ?? this.joined?.playerId;
      if (pid) this.net?.send({ t: 'bomb', pid });
    };
    this.applyLayouts();
    this.input.attach();
    this.syncInputEnabled();
  }

  // --- Local players (shared-keyboard multiplayer) ---

  /** Ids of the players this device still controls (kicked ones excluded). */
  myIds(): string[] {
    if (this.localIds.length > 0) return this.localIds.filter((id) => !this.removedLocalIds.has(id));
    return this.joined ? [this.joined.playerId] : [];
  }

  /** Pad slot of a player id, or -1 if it isn't one of ours. */
  padSlotOf(id: string): number {
    return this.localIds.indexOf(id);
  }

  /**
   * Apply the adaptive key layout for the current local player count. Called
   * on join and on lobby roster changes only - never mid-match (requirement:
   * bindings are locked once a round starts).
   */
  private applyLayouts(): void {
    this.currentPresets = layoutFor(Math.max(this.localIds.length, 1));
    this.input.setBindings(this.currentPresets.map((p) => p.keys));
  }

  /** Reconcile our local player list with the lobby roster, remap if changed. */
  private syncLocalIds(): void {
    if (!this.room || !this.joined) return;
    const primary = this.joined.playerId;
    const next = this.room.players
      .filter((p) => p.id === primary || p.ownerId === primary)
      .map((p) => p.id);
    this.removedLocalIds.clear();
    if (next.join('\n') === this.localIds.join('\n')) return;
    this.localIds = next;
    this.applyLayouts();
  }

  presetLabel(preset: PadPreset): string {
    return `${preset.moveLabel} + ${preset.bombLabel}`;
  }

  /** Briefly show each local player their controls (match start / remap). */
  private showControlsFlash(): void {
    if (this.isTouch || !this.room) return;
    const lines: ControlsFlashLine[] = [];
    for (const [slot, id] of this.localIds.entries()) {
      const player = this.room.players.find((p) => p.id === id);
      const preset = this.currentPresets[slot];
      if (!player || !preset) continue;
      lines.push({
        text: `${player.nickname.toUpperCase().slice(0, 10)}: `,
        color: playerColorCss(this.slotOf(id)),
        suffix: this.presetLabel(preset),
      });
    }
    if (lines.length === 0) return;
    this.flashControls(lines, 4500);
  }

  private flashControls(lines: ControlsFlashLine[], ms: number): void {
    this.controlsFlash = lines;
    if (this.controlsFlashTimer !== null) clearTimeout(this.controlsFlashTimer);
    this.controlsFlashTimer = window.setTimeout(() => {
      this.controlsFlash = null;
      this.emit();
    }, ms);
    this.emit();
  }

  // --- Joining ---

  /** Empty input = the fun placeholder name. */
  effectiveNickname(): string {
    return this.nickname.trim() || this.placeholderNickname;
  }

  setNickname(value: string): void {
    this.nickname = value;
    this.emit();
  }

  private storedSession(): StoredSession | null {
    try {
      const raw = sessionStorage.getItem('session');
      return raw ? (JSON.parse(raw) as StoredSession) : null;
    } catch {
      return null;
    }
  }

  private setScreen(name: ScreenName): void {
    this.screen = name;
    // Every non-game screen is a menu: play the calm theme there. The battle
    // track is driven by round state instead (startMusic/stopMusic above).
    if (name !== 'game') audio.startMenuMusic();
    this.emit();
  }

  private setError(message: string): void {
    this.landingError = message;
    this.emit();
  }

  async join(mode: JoinMode, rejoinToken?: string): Promise<void> {
    this.landingError = '';
    if (this.joinView) this.joinView.error = '';
    localStorage.setItem('nickname', this.effectiveNickname());
    this.joining = true;
    this.emit();
    try {
      // The auth cookie must exist before the WS upgrade so play counts toward
      // the (anonymous) account; ensureAccount never blocks on auth failures.
      await ensureAccount();
      this.net?.close();
      this.net = new Net();
      this.net.onMessage = (msg) => this.handleMessage(msg);
      this.net.onClose = () => this.handleClose();
      await this.net.connect();
      const skin = effectiveSkin();
      this.net.send({
        t: 'join',
        nickname: this.effectiveNickname(),
        mode,
        ...(isFreeSkin(skin) ? {} : { skin }),
        ...(rejoinToken ? { rejoinToken } : {}),
      });
    } catch {
      if (this.screen === 'join' && this.joinView) this.joinView.error = 'COULD NOT REACH THE SERVER';
      else this.landingError = 'COULD NOT REACH THE SERVER';
    } finally {
      this.joining = false;
      this.emit();
    }
  }

  private handleMessage(msg: ServerMessage): void {
    if (msg.t === 'joined') {
      this.joined = msg;
      this.reconnecting = false;
      this.joinView = null;
      rememberRoom(msg.roomId, msg.isPrivate, msg.roomName);
      this.afkWarnings.clear();
      this.removedLocalIds.clear();
      this.localIds = [msg.playerId, ...(msg.localPlayerIds ?? [])];
      this.applyLayouts();
      this.myDeathAt = null;
      this.buffer.clear();
      this.fx.reset();
      this.hapticEvents.reset();
      this.soundEvents.reset();
      this.input.reset();
      this.touchControls?.resync(); // a held joystick direction survives a reconnect
      sessionStorage.setItem(
        'session',
        JSON.stringify({ token: msg.token, roomId: msg.roomId, nickname: this.effectiveNickname() }),
      );
      if (location.pathname !== `/room/${msg.roomId}`) {
        // Push (not replace) so the browser back button can leave the room.
        history.pushState(null, '', `/room/${msg.roomId}`);
      }
      this.emit();
    } else if (msg.t === 'error') {
      this.handleServerError(msg.code, msg.message);
    } else if (msg.t === 'room') {
      const prevState = this.room?.state;
      this.room = msg;
      this.lobbyNotice = null;
      this.syncArenaSize(msg.maxPlayers);
      this.buffer.noteServerTime(msg.serverTime);
      if (msg.state !== 'playing') this.afkWarnings.clear();
      // Layout remaps happen in the lobby only; mid-match pads stay frozen.
      if (msg.state === 'lobby' || msg.state === 'countdown') this.syncLocalIds();
      if (msg.state === 'playing' && prevState !== 'playing') {
        this.roundStartAt = msg.serverTime;
        this.myDeathAt = null;
        this.buffer.clear();
        this.fx.reset();
        this.hapticEvents.reset();
        this.soundEvents.reset();
        audio.startMusic();
        this.input.resend(); // new round resets server dirs; a held direction must re-apply
        if (!this.allMineSpectating()) {
          // Joining mid-match seats us as spectators: READY/GO and the controls
          // flash would wrongly say "you're playing", so they're fighters-only.
          audio.roundStart(); // READY/GO beeps, in step with the banner
          this.showControlsFlash(); // nobody should have to guess their keys after a remap
        }
      }
      if (msg.state === 'roundEnd' && prevState === 'playing') {
        audio.stopMusic(); // round is over: let the win/lose moment breathe
        if (msg.winnerId !== null && this.myIds().includes(msg.winnerId)) {
          this.hapticEvents.matchWon();
          audio.victory();
        }
      }
      if (msg.state === 'lobby' || msg.state === 'countdown') {
        audio.stopMusic();
        this.closeMenu();
        this.setScreen('lobby');
      } else {
        this.setScreen('game');
      }
    } else if (msg.t === 'snapshot') {
      this.buffer.push(msg);
      this.fx.process(msg);
      this.hapticEvents.processSnapshot(msg, this.joined?.playerId ?? null);
      this.soundEvents.processSnapshot(msg, this.myIds());
      // All of this device's fighters down -> remember when, for the death UI.
      // (Spectators never appear in snapshots, so they don't count here.)
      const mine = this.myIds();
      const mineSnaps = msg.players.filter((p) => mine.includes(p.id));
      const allDead = mineSnaps.length > 0 && mineSnaps.every((p) => !p.alive);
      if (allDead !== (this.myDeathAt !== null)) {
        this.myDeathAt = allDead ? msg.serverTime : null;
        this.emit();
      }
    } else if (msg.t === 'afk') {
      if (msg.kickAt === null) {
        this.afkWarnings.delete(msg.playerId);
      } else {
        const wasShowing = this.afkWarnings.size > 0;
        this.afkWarnings.set(msg.playerId, msg.kickAt);
        if (!wasShowing) this.hapticEvents.afkWarning();
      }
      this.emit();
    } else if (msg.t === 'kicked') {
      if (msg.reason === 'host') {
        // Host kicks remove the whole connection: every local player goes too.
        this.removedReason = 'host';
        this.handleKicked();
      } else {
        this.handleKickedPlayer(msg.playerId);
      }
    }
  }

  /**
   * The server AFK-kicked one of our players. With several local players the
   * others keep playing; only when the last one is gone does the whole session
   * end on the removed screen.
   */
  private handleKickedPlayer(playerId: string): void {
    this.afkWarnings.delete(playerId);
    if (this.localIds.includes(playerId)) this.removedLocalIds.add(playerId);
    if (this.myIds().length === 0) {
      this.removedReason = 'afk';
      this.handleKicked();
      return;
    }
    // Brief notice to the shared screen; the survivors play on.
    const name = this.room?.players.find((p) => p.id === playerId)?.nickname ?? 'PLAYER';
    this.flashControls([{ text: `${name.toUpperCase().slice(0, 12)} WAS REMOVED (AFK)` }], 3500);
  }

  /** Server removed us (inactivity): land on the dedicated removed screen. */
  private handleKicked(): void {
    this.afkWarnings.clear();
    this.localIds = [];
    this.removedLocalIds.clear();
    sessionStorage.removeItem('session');
    this.closeMenu();
    this.net?.close();
    this.net = null;
    this.joined = null;
    this.room = null;
    this.buffer.clear();
    this.fx.reset();
    audio.stopMusic();
    history.replaceState(null, '', '/');
    this.setScreen('removed');
  }

  private handleServerError(code: string, message: string): void {
    // Errors for a join-screen attempt render inline on the join screen.
    if (this.joinView !== null && this.room === null) {
      const view = this.joinView;
      if (code === 'password_required' || code === 'bad_password') {
        view.forcePassword = true;
        view.error = code === 'bad_password' ? 'WRONG PASSWORD' : 'THIS ROOM NEEDS A PASSWORD';
        view.passwordFocusNonce++;
        this.emit();
        return;
      }
      if (code === 'room_not_found') {
        pruneRecentRoom(view.roomId);
        this.showJoinEdge('THIS ROOM NO LONGER EXISTS', 'ROOMS CLOSE WHEN EVERYONE LEAVES.');
        return;
      }
      if (code === 'room_full') {
        this.showJoinEdge('THIS ROOM IS FULL', 'TRY ANOTHER ROOM OR QUICK-JOIN A PUBLIC MATCH.');
        return;
      }
      if (code === 'rate_limited') {
        view.error = message.toUpperCase();
        view.passwordFocusNonce++;
        this.emit();
        return;
      }
    }
    if (code === 'rejoin_failed') {
      sessionStorage.removeItem('session');
      this.leaveToLanding();
      this.setError('RECONNECT WINDOW EXPIRED');
    } else if (
      code === 'not_host' ||
      code === 'cannot_start' ||
      code === 'no_such_bot' ||
      code === 'rate_limited' ||
      (code === 'not_allowed' && this.room !== null) ||
      (code === 'room_full' && this.room !== null)
    ) {
      this.lobbyNotice = message.toUpperCase();
      this.emit();
    } else {
      this.landingError = message.toUpperCase();
      this.setScreen('landing');
    }
  }

  private handleClose(): void {
    if (!this.joined || this.reconnecting) {
      if (!this.reconnecting) this.leaveToLanding();
      return;
    }
    void this.attemptReconnect();
  }

  private async attemptReconnect(): Promise<void> {
    const session = this.storedSession();
    if (!session) {
      this.leaveToLanding();
      return;
    }
    this.reconnecting = true;
    this.emit();
    const deadline = Date.now() + RECONNECT_GRACE_MS;
    while (Date.now() < deadline) {
      try {
        await this.join({ kind: 'join', roomId: session.roomId }, session.token);
        return; // 'joined' (or an error) will arrive and clear the flag
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    this.reconnecting = false;
    sessionStorage.removeItem('session');
    this.leaveToLanding();
    this.setError('CONNECTION LOST');
  }

  // --- In-game menu ---

  /** The menu is in-game only: never in the lobby or on the landing screen. */
  inMatch(): boolean {
    return (
      this.joined !== null &&
      this.room !== null &&
      (this.room.state === 'playing' || this.room.state === 'roundEnd')
    );
  }

  /** Game input is blocked by the menu and, on phones, by portrait mode. */
  private syncInputEnabled(): void {
    this.input.setEnabled(this.menu === 'closed' && !(this.isTouch && this.portraitQuery.matches));
  }

  openMenu(): void {
    if (this.menu !== 'closed' || !this.inMatch()) return;
    this.menu = 'main';
    // Block game keys and stop moving; the match keeps running underneath.
    this.syncInputEnabled();
    this.touchControls?.setVisible(false);
    this.emit();
  }

  closeMenu(): void {
    if (this.menu === 'closed') return;
    this.menu = 'closed';
    this.syncInputEnabled();
    this.touchControls?.setVisible(true);
    // Drop focus so a later space press bombs instead of re-clicking a button.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    this.emit();
  }

  openLeaveConfirm(): void {
    if (this.menu === 'closed') return;
    this.menu = 'confirm';
    this.emit();
  }

  cancelLeaveConfirm(): void {
    if (this.menu !== 'confirm') return;
    this.menu = 'main';
    this.emit();
  }

  async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        // Best effort (Android): keep the match locked to landscape.
        const orientation = screen.orientation as unknown as {
          lock?: (mode: string) => Promise<void>;
        };
        await orientation.lock?.('landscape');
      }
    } catch {
      // Lock/fullscreen rejection is fine - the rotate overlay still guards portrait.
    }
    this.emit();
  }

  /** Settings (sound/haptics/a2hs) live elsewhere; this just repaints the menu. */
  refresh(): void {
    this.emit();
  }

  private leaveToLanding(): void {
    this.closeMenu();
    this.net?.close();
    this.net = null;
    this.joined = null;
    this.room = null;
    this.joinView = null;
    this.localIds = [];
    this.removedLocalIds.clear();
    this.afkWarnings.clear();
    this.applyLayouts();
    this.buffer.clear();
    this.fx.reset();
    audio.stopMusic();
    history.replaceState(null, '', '/');
    this.setScreen('landing');
  }

  /** Leave the room (lobby button, in-game confirm, back navigation). */
  leaveRoom(): void {
    this.net?.send({ t: 'leave' });
    sessionStorage.removeItem('session');
    this.leaveToLanding();
  }

  backToLanding(): void {
    this.setScreen('landing');
  }

  // --- Join screen (invite links and the room browser share this flow) ---

  private showJoinEdge(title: string, msg: string): void {
    if (!this.joinView) return;
    this.joinView.edge = { title, msg };
    this.emit();
  }

  /** Paint a preview result; `first` also seeds the inputs and focus. */
  applyJoinPreview(roomId: string, preview: RoomPreview, first: boolean): void {
    const view = this.joinView;
    if (!view || view.roomId !== roomId) return;
    if (preview.kind === 'not_found') {
      view.preview = preview;
      pruneRecentRoom(roomId);
      this.showJoinEdge('THIS ROOM NO LONGER EXISTS', 'ROOMS CLOSE WHEN EVERYONE LEAVES.');
      return;
    }
    if (preview.kind === 'unreachable') {
      // On a refresh tick a blip just keeps the last known state on screen.
      if (first) {
        view.preview = preview;
        this.showJoinEdge('COULD NOT REACH THE SERVER', 'CHECK YOUR CONNECTION AND TRY AGAIN.');
      }
      return;
    }
    view.preview = preview;
    const info = preview.info;
    if (!info.joinable) {
      this.showJoinEdge(
        'THIS ROOM IS FULL',
        info.status === 'in_match'
          ? 'A MATCH IS RUNNING WITH NO FREE SLOTS - TRY AGAIN IN A BIT.'
          : 'TRY ANOTHER ROOM OR QUICK-JOIN A PUBLIC MATCH.',
      );
      return;
    }
    view.edge = null;
    this.emit();
  }

  async openJoinScreen(roomId: string, push: boolean): Promise<void> {
    this.joinView = {
      roomId,
      preview: null,
      edge: null,
      forcePassword: false,
      error: '',
      passwordFocusNonce: 0,
    };
    if (push && location.pathname !== `/room/${roomId}`) {
      history.pushState(null, '', `/room/${roomId}`);
    }
    this.setScreen('join');
    const preview = await fetchRoomInfo(roomId);
    if (this.joinView?.roomId !== roomId || this.joined !== null) return; // navigated away meanwhile
    this.applyJoinPreview(roomId, preview, true);
  }

  joinRoom(password: string): void {
    const view = this.joinView;
    if (!view) return;
    const needsPassword =
      view.forcePassword || (view.preview?.kind === 'ok' && view.preview.info.passwordRequired);
    if (needsPassword && !password) {
      view.error = 'THIS ROOM NEEDS A PASSWORD';
      view.passwordFocusNonce++;
      this.emit();
      return;
    }
    const roomId = view.roomId;
    void this.join(needsPassword ? { kind: 'join', roomId, password } : { kind: 'join', roomId });
  }

  goHome(): void {
    this.joinView = null;
    history.pushState(null, '', '/');
    this.setScreen('landing');
  }

  // --- Standalone pages (skins / settings) ---

  /** Landing-only navigation; pushes a URL so the back button returns home. */
  openPage(name: PageName): void {
    if (this.joined !== null) return;
    if (location.pathname !== PAGE_PATHS[name]) {
      history.pushState(null, '', PAGE_PATHS[name]);
    }
    this.setScreen(name);
  }

  // --- Lobby actions ---

  toggleReady(): void {
    if (!this.room) return;
    const mine = this.room.players.filter((p) => !p.bot && this.myIds().includes(p.id));
    const ready = !(mine.length > 0 && mine.every((p) => p.ready));
    // The server ignores no-op toggles, so blanket-sending is safe.
    for (const p of mine) this.net?.send({ t: 'ready', ready, pid: p.id });
  }

  startGame(): void {
    this.net?.send({ t: 'start' });
  }

  addBot(): void {
    this.net?.send({ t: 'addBot' });
  }

  addLocal(): void {
    this.net?.send({ t: 'addLocal' });
  }

  removeBot(botId: string): void {
    this.net?.send({ t: 'removeBot', botId });
  }

  removeLocal(playerId: string): void {
    this.net?.send({ t: 'removeLocal', playerId });
  }

  /** Host only: kick a player (the server removes their whole connection). */
  kickPlayer(playerId: string): void {
    this.net?.send({ t: 'kick', playerId });
  }

  renameLocal(playerId: string, nickname: string): void {
    this.net?.send({ t: 'renameLocal', playerId, nickname });
  }

  setRoomSize(size: RoomSize): void {
    this.net?.send({ t: 'setSize', size });
  }

  /** Public rooms are hostless: hostId is always null there. */
  isHost(): boolean {
    const room = this.room;
    return (
      room !== null && room.isPrivate && room.hostId !== null && this.myIds().includes(room.hostId)
    );
  }

  fmtSeconds(deadline: number): string {
    return Math.max(Math.ceil((deadline - this.buffer.serverNow()) / 1000), 0).toString();
  }

  /** Every player this device controls is seated as a spectator. */
  allMineSpectating(): boolean {
    const mine = this.room?.players.filter((p) => this.myIds().includes(p.id)) ?? [];
    return mine.length > 0 && mine.every((p) => p.spectator);
  }

  /** Sprite/color slot of a player: order among non-spectators, by roster order. */
  slotOf(id: string): number {
    if (!this.room) return 0;
    const fighters = this.room.players.filter((p) => !p.spectator);
    const i = fighters.findIndex((p) => p.id === id);
    return i >= 0 ? i % ROOM_MAX_PLAYERS : 0;
  }

  lobbyStatusText(): string {
    const room = this.room;
    if (!room || !this.joined) return '';
    if (this.lobbyNotice !== null) return this.lobbyNotice;
    const connected = room.players.filter((p) => p.connected).length;
    if (room.state === 'countdown' && room.countdownEndsAt !== null) {
      return `STARTING IN ${this.fmtSeconds(room.countdownEndsAt)}...`;
    }
    if (room.isPrivate) {
      if (connected < ROOM_MIN_PLAYERS) return 'SHARE THE LINK - NEED 2+ PLAYERS';
      return this.isHost() ? 'PRESS START WHEN READY!' : 'WAITING FOR HOST TO START...';
    }
    const humans = room.players.filter((p) => !p.bot && p.connected);
    const ready = humans.filter((p) => p.ready).length;
    const counts = `${ready}/${humans.length} READY`;
    if (room.readyTimerEndsAt !== null) {
      return `${counts} - STARTING IN ${this.fmtSeconds(room.readyTimerEndsAt)}S`;
    }
    return `${counts} - READY UP TO START`;
  }

  /** Full-canvas overlay: reconnect blackout or the translucent AFK countdown. */
  overlayInfo(): { title: string; sub: string; afk: boolean } | null {
    if (this.reconnecting) return { title: 'RECONNECTING...', sub: 'HANG TIGHT', afk: false };
    if (this.afkWarnings.size === 0) return null;
    const soonest = Math.min(...this.afkWarnings.values());
    const secs = Math.max(Math.ceil((soonest - this.buffer.serverNow()) / 1000), 0);
    // With several local players, name who the warning is for.
    const names = [...this.afkWarnings.keys()]
      .map((id) => this.room?.players.find((p) => p.id === id)?.nickname.toUpperCase().slice(0, 10))
      .filter((n): n is string => n !== undefined);
    const sub =
      this.myIds().length > 1 && names.length > 0 ? `${names.join(', ')}: ${secs}S` : `${secs}S`;
    return { title: "MOVE OR YOU'LL BE REMOVED", sub, afk: true };
  }

  /** Canvas banner for the current moment: READY/GO at round start, win screen. */
  private currentBanner(): BannerState | null {
    if (this.demoBanner) return this.demoBanner;
    const room = this.room;
    if (!room) return null;
    const now = this.buffer.serverNow();
    if (room.state === 'playing' && this.roundStartAt !== null) {
      const elapsed = now - this.roundStartAt;
      // Spectators get no READY/GO: joining mid-match must not read as playing.
      if (!this.allMineSpectating()) {
        if (elapsed < 1000) return { lines: [{ text: 'READY...', colorIdx: 10, scale: 2 }] };
        if (elapsed < 1600) return { lines: [{ text: 'GO!', colorIdx: 11, scale: 3 }] };
      }
      // The moment of death gets a big banner so nobody keeps "playing" a corpse.
      if (this.myDeathAt !== null) {
        const since = now - this.myDeathAt;
        if (since >= 0 && since < 2500) {
          return {
            lines: [
              {
                text: this.myIds().length > 1 ? "YOU'RE ALL DEAD!" : 'YOU DIED!',
                colorIdx: 8,
                scale: 3,
              },
              { text: 'SPECTATING UNTIL NEXT ROUND', colorIdx: 6, scale: 1 },
            ],
          };
        }
      }
      const sdAt = this.buffer.latest()?.suddenDeathAt;
      if (sdAt !== undefined) {
        const since = now - sdAt;
        if (since >= 0 && since < 2000) {
          return { lines: [{ text: 'SUDDEN DEATH!', colorIdx: 8, scale: 3 }] };
        }
      }
      // Bot-only finale: no humans left, so the round wraps up. Show a countdown
      // over its final window before one bot is crowned and the rest are killed.
      const finaleAt = this.buffer.latest()?.botFinaleAt;
      if (finaleAt !== undefined) {
        const remaining = finaleAt - now;
        if (remaining > 0 && remaining <= BOT_FINALE_COUNTDOWN_MS) {
          return {
            lines: [
              { text: 'NO PLAYERS LEFT', colorIdx: 8, scale: 2 },
              { text: `WINNER IN ${this.fmtSeconds(finaleAt)}`, colorIdx: 6, scale: 1 },
            ],
          };
        }
      }
      return null;
    }
    if (room.state === 'roundEnd') {
      const winner = room.winnerId ? room.players.find((p) => p.id === room.winnerId) : null;
      const lines: BannerState['lines'] = [];
      if (winner) {
        lines.push({
          text: `${winner.nickname.toUpperCase().slice(0, 12)} WINS!`,
          colorIdx: 10,
          scale: 2,
        });
      } else {
        lines.push({ text: 'DRAW!', colorIdx: 6, scale: 2 });
      }
      if (room.countdownEndsAt !== null) {
        lines.push({
          text: `NEXT ROUND IN ${this.fmtSeconds(room.countdownEndsAt)}`,
          colorIdx: 6,
          scale: 1,
        });
      }
      const banner: BannerState = { lines };
      if (winner) {
        banner.victorySprite = this.slotOf(winner.id);
        if (winner.skin) banner.victorySkin = winner.skin;
      }
      return banner;
    }
    return null;
  }

  // --- Canvas / scaling (the game stays pixel-perfect canvas rendering) ---

  // --- Branded bricks (in-game hover/tap popup) ---

  /** Branded brick under a viewport point, with its on-screen box, or null. */
  brickAtPoint(clientX: number, clientY: number): BrickHit | null {
    return this.renderer?.brickAt(clientX, clientY) ?? null;
  }

  /** Tell the renderer which brick to highlight (null clears it). */
  setHoveredBrick(id: string | null): void {
    this.renderer?.setHoveredBrick(id);
  }

  /** Report a branded-brick impression ('view') or VISIT click to the server. */
  recordBrickEvent(id: string, kind: 'view' | 'click'): void {
    this.net?.send({ t: 'brickEvent', id, kind });
  }

  /** Point the renderer, fx and scaling at the arena for this player cap. */
  private syncArenaSize(maxPlayers: number): void {
    if (maxPlayers === this.arenaMaxPlayers) return;
    this.arenaMaxPlayers = maxPlayers;
    const { width, height } = ROOM_SIZE_GRID[roomSizeFor(maxPlayers)];
    this.fx.gridWidth = width;
    if (this.renderer) {
      this.renderer.setGrid(width, height);
      this.applyScale();
    } else {
      this.pendingGrid = { width, height };
    }
  }

  private safeInsets(): { t: number; r: number; b: number; l: number } {
    const rect = this.insetProbe?.getBoundingClientRect();
    if (!rect) return { t: 0, r: 0, b: 0, l: 0 };
    return {
      t: rect.top,
      r: window.innerWidth - rect.right,
      b: window.innerHeight - rect.bottom,
      l: rect.left,
    };
  }

  /**
   * Desktop: largest integer scale that fits (crisp pixels). Touch devices:
   * fractional CSS scale so the whole arena fills a phone screen, letterboxed
   * by the flex centering around it. The HUD always stacks statically above
   * the arena (never overlays it); the arena takes the remaining height.
   * The canvas backing store always renders at CSS-size x devicePixelRatio so
   * sprites stay crisp at fractional scales (no blurry upsampling).
   */
  applyScale = (): void => {
    const renderer = this.renderer;
    const canvas = this.canvas;
    if (!renderer || !canvas) return;
    const viewW = renderer.viewW;
    const viewH = renderer.viewH;
    const dpr = window.devicePixelRatio || 1;
    if (!this.isTouch) {
      const maxW = window.innerWidth - 40;
      // Leave room for the HUD bar, which grows taller when the roster wraps.
      const maxH = window.innerHeight - ((this.hudEl?.offsetHeight || 44) + 66);
      const scale = Math.max(1, Math.min(Math.floor(maxW / viewW), Math.floor(maxH / viewH)));
      canvas.style.width = `${viewW * scale}px`;
      canvas.style.height = `${viewH * scale}px`;
      renderer.setPixelScale(scale * dpr);
      return;
    }
    const ins = this.safeInsets();
    const fit = (hudH: number): number => {
      const maxW = window.innerWidth - ins.l - ins.r - 8;
      const maxH = window.innerHeight - ins.t - ins.b - hudH - 10;
      return Math.max(0.5, Math.min(maxW / viewW, maxH / viewH));
    };
    const scale = fit(this.hudEl?.offsetHeight || 44);
    const cssW = Math.floor(viewW * scale);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${Math.floor(viewH * scale)}px`;
    renderer.setPixelScale((cssW * dpr) / viewW);
  };

  /**
   * Wire the always-mounted game screen DOM: canvas renderer, HUD measuring,
   * touch controls and the 60fps render loop. Called once from React.
   */
  attachGame(els: { screenEl: HTMLElement; hudEl: HTMLElement; canvas: HTMLCanvasElement }): void {
    if (this.renderer) return;
    this.hudEl = els.hudEl;
    this.canvas = els.canvas;
    this.renderer = new Renderer(els.canvas);
    if (this.pendingGrid) {
      this.renderer.setGrid(this.pendingGrid.width, this.pendingGrid.height);
      this.pendingGrid = null;
    }

    /** Notch insets, measured via a probe because env() isn't readable from JS. */
    this.insetProbe = document.createElement('div');
    this.insetProbe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;' +
      'left:env(safe-area-inset-left,0px);top:env(safe-area-inset-top,0px);' +
      'right:env(safe-area-inset-right,0px);bottom:env(safe-area-inset-bottom,0px);';
    document.body.appendChild(this.insetProbe);

    this.applyScale();
    window.addEventListener('resize', this.applyScale);
    window.addEventListener('orientationchange', this.applyScale);
    window.visualViewport?.addEventListener('resize', this.applyScale);
    // The HUD grows taller when the roster wraps (many players): re-fit the
    // arena so the HUD never pushes the canvas off-screen.
    new ResizeObserver(() => this.applyScale()).observe(els.hudEl);

    if (this.isTouch) {
      this.touchControls = new TouchControls(els.screenEl, HUD_ICONS.bomb, {
        onDir: (dir) => {
          this.input.setTouchDir(dir);
          if (dir !== null) this.hapticEvents.joystickTick();
        },
        onBomb: () => {
          if (this.input.touchBomb()) this.hapticEvents.bombPressed();
        },
      });
      // No long-press context menu / text selection during play.
      window.addEventListener('contextmenu', (ev) => {
        if (this.screen === 'game') ev.preventDefault();
      });
    }

    const frame = (): void => {
      if (this.screen === 'game') {
        this.renderer?.frame({
          view: this.buffer.sample(),
          roster: this.room?.players ?? [],
          myIds: this.myIds(),
          serverNow: this.buffer.serverNow(),
          fx: this.fx,
          banner: this.currentBanner(),
        });
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  /** Render one frame at a server-time offset (demo benchmark hook). */
  private benchFrame(offset: number): void {
    this.renderer?.frame({
      view: this.buffer.sample(),
      roster: this.room?.players ?? [],
      myIds: this.myIds(),
      serverNow: this.buffer.serverNow() + offset,
      fx: this.fx,
      banner: this.currentBanner(),
    });
  }

  // --- Boot ---

  /** Global listeners + initial route. Called once, after attachGame. */
  boot(): void {
    const onPortraitChange = (): void => {
      this.syncInputEnabled();
      this.applyScale();
    };
    // Safari < 14 only has the deprecated addListener; don't blank-screen there.
    if (typeof this.portraitQuery.addEventListener === 'function') {
      this.portraitQuery.addEventListener('change', onPortraitChange);
    } else {
      (this.portraitQuery as { addListener?: (cb: () => void) => void }).addListener?.(
        onPortraitChange,
      );
    }

    document.addEventListener('fullscreenchange', () => {
      this.emit();
      this.applyScale();
    });

    window.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (this.menu !== 'closed') {
        ev.preventDefault();
        this.closeMenu();
      } else if (this.inMatch() && this.screen === 'game') {
        ev.preventDefault();
        this.openMenu();
      }
    });

    // Back/forward navigation: home <-> join screens, and leaving a room.
    window.addEventListener('popstate', () => {
      if (this.joined !== null) {
        // Demo sessions and the reconnect overlay don't navigate on back.
        if (this.net === null || this.reconnecting) return;
        if (this.inMatch()) {
          // An accidental back press must not kill a running match: restore the
          // entry and route through the in-game leave confirmation instead.
          history.pushState(null, '', `/room/${this.joined.roomId}`);
          this.openMenu();
          this.openLeaveConfirm();
          return;
        }
        // In the lobby, back means "leave the room".
        this.leaveRoom();
        return;
      }
      const m = /^\/room\/([a-z0-9]+)$/i.exec(location.pathname);
      if (m?.[1]) {
        void this.openJoinScreen(m[1], false);
        return;
      }
      const page = (Object.keys(PAGE_PATHS) as PageName[]).find(
        (p) => PAGE_PATHS[p] === location.pathname,
      );
      if (page) {
        this.setScreen(page);
      } else {
        this.joinView = null;
        this.setScreen('landing');
      }
    });

    // The join preview stays live while the join screen is open, so a room
    // going in-match (or filling up) shows without a reload.
    setInterval(() => {
      const roomId = this.joinView?.roomId;
      if (roomId === undefined || this.joined !== null) return;
      if (document.visibilityState !== 'visible') return;
      if (this.screen !== 'join') return;
      void fetchRoomInfo(roomId).then((preview) => {
        if (this.joinView?.roomId === roomId && this.joined === null) {
          this.applyJoinPreview(roomId, preview, false);
        }
      });
    }, 3000);

    // Email-link landings: /api/auth/verify redirects to /account?verified=N
    // and reset emails link to /reset?token=...; both normalize to /account.
    const search = new URLSearchParams(location.search);
    const verified = search.get('verified');
    if (verified !== null) {
      setVerifyNotice(verified === '1' ? 'ok' : 'failed');
      history.replaceState(null, '', '/account');
    }
    if (location.pathname === '/reset') {
      setResetToken(search.get('token'));
      history.replaceState(null, '', '/account');
    }

    const urlRoomId = ((): string | null => {
      const m = /^\/room\/([a-z0-9]+)$/i.exec(location.pathname);
      return m?.[1] ?? null;
    })();

    this.demoMode = maybeStartDemo({
      buffer: this.buffer,
      fx: this.fx,
      showScreen: (name) => this.setScreen(name),
      setRoom: (r) => {
        this.room = r;
        this.syncArenaSize(r.maxPlayers);
        this.emit();
      },
      setJoined: (j) => {
        this.joined = j;
      },
      setBanner: (b) => {
        this.demoBanner = b;
      },
      setRoundStartAt: (t) => {
        this.roundStartAt = t;
      },
      benchFrame: (offset) => this.benchFrame(offset),
    });
    if (this.demoMode) return;

    // If we got here via a reload mid-game, try to resume the session.
    const session = this.storedSession();
    if (session && (!urlRoomId || session.roomId === urlRoomId)) {
      this.nickname = session.nickname;
      this.joined = {
        t: 'joined',
        playerId: '',
        roomId: session.roomId,
        roomName: '',
        token: session.token,
        isPrivate: false,
        spectator: false,
      };
      void this.attemptReconnect();
    } else if (urlRoomId) {
      // Invite link: a dedicated join screen with a live room preview.
      void this.openJoinScreen(urlRoomId, false);
    } else {
      const page = (Object.keys(PAGE_PATHS) as PageName[]).find(
        (p) => PAGE_PATHS[p] === location.pathname,
      );
      this.setScreen(page ?? 'landing');
    }
  }
}

export const session = new GameSession();
