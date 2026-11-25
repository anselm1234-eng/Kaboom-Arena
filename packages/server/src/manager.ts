import { DEFAULT_ROOM_SIZE_DESKTOP, type RoomSize } from '@blastmates/shared';
import { randomRoomId } from './ids';
import { randomRoomName } from './names';
import { Room, type RoomOptions } from './room';

export type ManagerRoomOptions = Pick<
  RoomOptions,
  'brickCandidates' | 'onBrickStats' | 'suddenDeath' | 'afk' | 'publicStart'
>;

/** What the join screen / room browser may see about a room. */
export interface RoomInfo {
  roomId: string;
  name: string;
  isPrivate: boolean;
  /** Only reveals THAT a password is needed, never the password itself. */
  passwordRequired: boolean;
  /** Coarse status: countdown counts as lobby, roundEnd as in_match. */
  status: 'lobby' | 'in_match';
  players: number;
  maxPlayers: number;
  humans: number;
  bots: number;
  joinable: boolean;
}

/** A connected human player, as the admin online list sees them. */
export interface OnlinePlayer {
  nickname: string;
  roomId: string;
  roomName: string;
  roomStatus: 'lobby' | 'in_match';
  isPrivate: boolean;
  spectator: boolean;
}

function roomInfo(room: Room): RoomInfo {
  const roster = [...room.roster.values()];
  const humans = roster.filter((p) => !p.bot && p.connected).length;
  const bots = roster.filter((p) => p.bot).length;
  return {
    roomId: room.id,
    name: room.name,
    isPrivate: room.isPrivate,
    passwordRequired: room.hasPassword(),
    status: room.state === 'lobby' || room.state === 'countdown' ? 'lobby' : 'in_match',
    players: humans + bots,
    maxPlayers: room.maxPlayers,
    humans,
    bots,
    joinable: room.joinable(),
  };
}

/**
 * Owns all rooms and implements matchmaking: quick-match fills public rooms
 * (preferring ones that have not started, then fullest first) and never
 * touches private rooms.
 */
export class RoomManager {
  readonly rooms = new Map<string, Room>();
  /** rejoin token -> location of the player it belongs to */
  readonly tokens = new Map<string, { roomId: string; playerId: string }>();

  private readonly rng: () => number;
  private readonly roomOptions: ManagerRoomOptions;

  constructor(rng: () => number = Math.random, roomOptions: ManagerRoomOptions = {}) {
    this.rng = rng;
    this.roomOptions = roomOptions;
  }

  private newRoom(isPrivate: boolean, size: RoomSize, password?: string): Room {
    let id = randomRoomId();
    while (this.rooms.has(id)) id = randomRoomId();
    const taken = new Set([...this.rooms.values()].map((r) => r.name));
    const room = new Room(id, isPrivate, password, {
      ...this.roomOptions,
      rng: this.rng,
      size,
      name: randomRoomName(this.rng, taken),
      onEmpty: (r) => this.destroyRoom(r.id),
    });
    this.rooms.set(id, room);
    return room;
  }

  /**
   * Quick match joins an open public room of exactly the requested size,
   * or creates a fresh one of that size - never a different-size room.
   */
  quickMatch(size: RoomSize = DEFAULT_ROOM_SIZE_DESKTOP): Room {
    const open = [...this.rooms.values()].filter(
      (r) => !r.isPrivate && r.maxPlayers === size && r.hasSlot(),
    );
    const joinable = open.filter((r) => r.state === 'lobby' || r.state === 'countdown');
    // Fill the fullest room first so games reach 2+ players quickly.
    const pick = (rooms: Room[]): Room | undefined =>
      rooms.sort((a, b) => b.roster.size - a.roster.size)[0];
    return pick(joinable) ?? pick(open) ?? this.newRoom(false, size);
  }

  createPrivate(size: RoomSize = DEFAULT_ROOM_SIZE_DESKTOP, password?: string): Room {
    return this.newRoom(true, size, password);
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /** Preview for the join screen; works for private rooms too (invite links). */
  roomInfo(roomId: string): RoomInfo | null {
    const room = this.rooms.get(roomId);
    return room ? roomInfo(room) : null;
  }

  /**
   * Public rooms with at least one human, for the home-screen browser.
   * Private rooms never appear. Joinable rooms with the most humans first.
   */
  listPublicRooms(): RoomInfo[] {
    return [...this.rooms.values()]
      .filter((r) => !r.isPrivate)
      .map(roomInfo)
      .filter((info) => info.humans > 0)
      .sort(
        (a, b) =>
          Number(b.joinable) - Number(a.joinable) ||
          Number(b.status === 'lobby') - Number(a.status === 'lobby') ||
          b.humans - a.humans,
      );
  }

  /** Every connected human across all rooms, for the admin online list. */
  onlinePlayers(): OnlinePlayer[] {
    const players: OnlinePlayer[] = [];
    for (const room of this.rooms.values()) {
      const info = roomInfo(room);
      for (const p of room.roster.values()) {
        if (p.bot || !p.connected) continue;
        players.push({
          nickname: p.nickname,
          roomId: room.id,
          roomName: room.name,
          roomStatus: info.status,
          isPrivate: room.isPrivate,
          spectator: p.spectator,
        });
      }
    }
    return players.sort((a, b) => a.roomName.localeCompare(b.roomName));
  }

  /** Headline live numbers for the admin dashboard. */
  liveStats(): {
    rooms: number;
    publicRooms: number;
    privateRooms: number;
    inMatch: number;
    humansOnline: number;
    bots: number;
  } {
    let publicRooms = 0;
    let privateRooms = 0;
    let inMatch = 0;
    let humansOnline = 0;
    let bots = 0;
    for (const room of this.rooms.values()) {
      const info = roomInfo(room);
      if (room.isPrivate) privateRooms++;
      else publicRooms++;
      if (info.status === 'in_match') inMatch++;
      humansOnline += info.humans;
      bots += info.bots;
    }
    return { rooms: this.rooms.size, publicRooms, privateRooms, inMatch, humansOnline, bots };
  }

  registerToken(token: string, roomId: string, playerId: string): void {
    this.tokens.set(token, { roomId, playerId });
  }

  lookupToken(token: string): { room: Room; playerId: string } | null {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    const room = this.rooms.get(entry.roomId);
    if (!room || !room.roster.has(entry.playerId)) {
      this.tokens.delete(token);
      return null;
    }
    return { room, playerId: entry.playerId };
  }

  destroyRoom(roomId: string): void {
    this.rooms.delete(roomId);
    for (const [token, entry] of this.tokens) {
      if (entry.roomId === roomId) this.tokens.delete(token);
    }
  }

  tickAll(now: number): void {
    for (const room of [...this.rooms.values()]) {
      room.tick(now);
    }
  }
}
