// --- Room sizes (the single source of truth for per-size map dimensions) ---

/** Configurable room sizes: how many players a room seats. */
export type RoomSize = 4 | 6 | 8;
export const ROOM_SIZES: readonly RoomSize[] = [4, 6, 8];

export interface GridDims {
  width: number;
  height: number;
}

/**
 * Map dimensions derive from the room size (playable grid, classic
 * odd-dimension pillar layout). Nothing else may hardcode dimensions.
 */
export const ROOM_SIZE_GRID: Record<RoomSize, GridDims> = {
  4: { width: 13, height: 11 },
  6: { width: 15, height: 13 },
  8: { width: 17, height: 15 },
};

/** Snap an arbitrary player cap to the room size that seats it. */
export function roomSizeFor(maxPlayers: number): RoomSize {
  return maxPlayers <= 4 ? 4 : maxPlayers <= 6 ? 6 : 8;
}

/** Mobile-first defaults: phones get cosier rooms, desktops the full arena. */
export const DEFAULT_ROOM_SIZE_TOUCH: RoomSize = 6;
export const DEFAULT_ROOM_SIZE_DESKTOP: RoomSize = 8;

export const CRATE_FILL = 0.7;
export const POWERUP_DROP_CHANCE = 0.3;

export const BOMB_FUSE_MS = 3000;
export const EXPLOSION_DURATION_MS = 500;

export const DEFAULT_BOMB_CAP = 1;
export const DEFAULT_RANGE = 2;
export const BASE_SPEED = 4; // tiles per second
export const SPEED_INCREMENT = 0.6;
export const MAX_BOMB_CAP = 8;
export const MAX_RANGE = 8;
export const MAX_SPEED = 8;

export const PLAYER_RADIUS = 0.38; // in tiles

export const TICK_RATE = 20; // server simulation + snapshot Hz
export const TICK_MS = 1000 / TICK_RATE;

export const ROOM_MIN_PLAYERS = 2;
/** Absolute cap across all room sizes (largest configurable size). */
export const ROOM_MAX_PLAYERS = 8;
/** Max players sharing one connection/keyboard (1 primary + 3 local). */
export const MAX_LOCAL_PLAYERS = 4;
/** Pre-match countdown shown before every public match start. */
export const PREMATCH_COUNTDOWN_MS = 3_000;
/** Public rooms: anti-stall timer armed when the first human readies up. */
export const READY_TIMEOUT_MS = 60_000;
/** Public rooms: bot fill target when a start would have <2 participants. */
export const BOT_FILL_TARGET = 4;
export const ROUND_END_MS = 5_000;
export const RECONNECT_GRACE_MS = 10_000;

/**
 * Bot-only endgame: once every human is dead but several bots are still
 * fighting, the round is wrapped up rather than left to a slow real-time
 * bot-vs-bot stall. The bots fight on for BOT_FINALE_PLAYON_MS, then a
 * BOT_FINALE_COUNTDOWN_MS countdown runs (clients show it); when it elapses one
 * surviving bot is crowned and the rest are killed. If the bots happen to settle
 * it down to a single survivor first, the round just ends normally.
 */
export const BOT_FINALE_PLAYON_MS = 3_000;
export const BOT_FINALE_COUNTDOWN_MS = 5_000;

export const INTERP_DELAY_MS = 100; // client renders this far behind server time

// --- AFK detection (live matches only; alive human players) ---

/** Inactivity after which the warning countdown appears. */
export const AFK_WARNING_MS = 15_000;
/** Inactivity after which the player is removed from the match. */
export const AFK_KICK_MS = 30_000;

// --- Sudden death (arena shrink) ---

/** Match time after which sudden death begins. */
export const SUDDEN_DEATH_AFTER_MS = 120_000;
/** One crush block lands every this often. */
export const CRUSH_INTERVAL_MS = 500;
/** Warning overlay lead time before a block lands on its tile. */
export const CRUSH_WARNING_MS = 1_500;
/** The spiral never fills the central safe area (side length, in tiles). */
export const CRUSH_SAFE_SIZE = 3;
/** Client: sudden-death countdown banner appears this long before it starts. */
export const SUDDEN_DEATH_COUNTDOWN_MS = 10_000;
