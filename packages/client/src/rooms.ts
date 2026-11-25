/** Room previews, the public room list, and device-local recent rooms. */

export interface RoomInfo {
  roomId: string;
  name: string;
  isPrivate: boolean;
  passwordRequired: boolean;
  status: 'lobby' | 'in_match';
  players: number;
  maxPlayers: number;
  humans: number;
  bots: number;
  joinable: boolean;
}

export type RoomPreview =
  | { kind: 'ok'; info: RoomInfo }
  | { kind: 'not_found' }
  | { kind: 'unreachable' };

export async function fetchRoomInfo(roomId: string): Promise<RoomPreview> {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`);
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) return { kind: 'unreachable' };
    const body = (await res.json()) as { room: RoomInfo };
    return { kind: 'ok', info: body.room };
  } catch {
    return { kind: 'unreachable' };
  }
}

export async function fetchPublicRooms(): Promise<RoomInfo[] | null> {
  try {
    const res = await fetch('/api/rooms');
    if (!res.ok) return null;
    const body = (await res.json()) as { rooms: RoomInfo[] };
    return body.rooms;
  } catch {
    return null;
  }
}

// --- Recent rooms (device-local; the only place private rooms are listed) ---

export interface RecentRoom {
  roomId: string;
  /** Display name; entries saved before names existed fall back to the code. */
  name?: string;
  isPrivate: boolean;
  /** Last joined/created, ms since epoch. */
  at: number;
}

const RECENT_KEY = 'recentRooms';
const RECENT_MAX = 5;

export function recentRooms(): RecentRoom[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RecentRoom =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as RecentRoom).roomId === 'string' &&
        typeof (r as RecentRoom).isPrivate === 'boolean' &&
        typeof (r as RecentRoom).at === 'number',
    );
  } catch {
    return [];
  }
}

function saveRecent(rooms: RecentRoom[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(rooms.slice(0, RECENT_MAX)));
  } catch {
    // storage full/blocked: recents are a nicety, not a requirement
  }
}

export function rememberRoom(roomId: string, isPrivate: boolean, name: string): void {
  const rest = recentRooms().filter((r) => r.roomId !== roomId);
  saveRecent([{ roomId, name, isPrivate, at: Date.now() }, ...rest]);
}

/** Drop a room that turned out to no longer exist. */
export function pruneRecentRoom(roomId: string): void {
  saveRecent(recentRooms().filter((r) => r.roomId !== roomId));
}

export function agoLabel(at: number): string {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (mins < 1) return 'JUST NOW';
  if (mins < 60) return `${mins}M AGO`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}H AGO`;
  return `${Math.round(hours / 24)}D AGO`;
}

// --- Nickname placeholder fun ---

// Any ADJECTIVE + ' ' + CRITTER combo must fit NicknameSchema's 16-char cap,
// so adjectives stay <= 8 chars and critters <= 7.
const FUN_ADJECTIVES = [
  'BLAST',
  'BOOM',
  'KABOOM',
  'SPICY',
  'TURBO',
  'ANGRY',
  'SNEAKY',
  'CRISPY',
  'WOBBLY',
  'GRUMPY',
  'DISCO',
  'FERAL',
  'NUCLEAR',
  'SWEATY',
  'MAJESTIC',
  'UNHINGED',
];

const FUN_CRITTERS = [
  'GOBLIN',
  'RACCOON',
  'TURTLE',
  'KOALA',
  'PICKLE',
  'WIZARD',
  'POTATO',
  'NOODLE',
  'WALRUS',
  'BANDIT',
  'NUGGET',
  'GREMLIN',
  'DONUT',
  'FERRET',
  'MUFFIN',
  'LLAMA',
];

export function funNickname(): string {
  const pick = (list: string[]): string => list[Math.floor(Math.random() * list.length)] ?? '';
  const name = `${pick(FUN_ADJECTIVES)} ${pick(FUN_CRITTERS)}`.trim();
  return name || 'BLAST BUDDY';
}
