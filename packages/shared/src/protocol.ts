import { z } from 'zod';
import { DANCE_IDS, HAT_IDS, SKIN_PALETTE_IDS } from './skins';

export const DirectionSchema = z.enum(['up', 'down', 'left', 'right']);
export type Direction = z.infer<typeof DirectionSchema>;

export const PowerupKindSchema = z.enum(['bomb', 'range', 'speed']);
export type PowerupKind = z.infer<typeof PowerupKindSchema>;

export const RoomStateSchema = z.enum(['lobby', 'countdown', 'playing', 'roundEnd']);
export type RoomState = z.infer<typeof RoomStateSchema>;

export const BotDifficultySchema = z.enum(['easy', 'normal']);
export type BotDifficulty = z.infer<typeof BotDifficultySchema>;

/** Configurable room sizes; mirrors the RoomSize type in constants. */
export const RoomSizeSchema = z.union([z.literal(4), z.literal(6), z.literal(8)]);

const NicknameSchema = z.string().trim().min(1).max(16);
const PasswordSchema = z.string().min(1).max(64);
const RoomIdSchema = z.string().min(1).max(32);
const PlayerIdSchema = z.string().min(1).max(64);

/** Cosmetic skin choice; ids validated against the legal catalog. */
export const SkinSchema = z.object({
  palette: z.enum(SKIN_PALETTE_IDS),
  hat: z.enum(HAT_IDS),
  dance: z.enum(DANCE_IDS),
});
export type SkinChoice = z.infer<typeof SkinSchema>;

export const JoinModeSchema = z.discriminatedUnion('kind', [
  /** Quick match prefers rooms of the requested size when picking/creating. */
  z.object({ kind: z.literal('quick'), size: RoomSizeSchema.optional() }),
  z.object({
    kind: z.literal('create'),
    password: PasswordSchema.optional(),
    size: RoomSizeSchema.optional(),
  }),
  z.object({ kind: z.literal('join'), roomId: RoomIdSchema, password: PasswordSchema.optional() }),
]);
export type JoinMode = z.infer<typeof JoinModeSchema>;

export const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('join'),
    nickname: NicknameSchema,
    mode: JoinModeSchema,
    skin: SkinSchema.optional(),
    rejoinToken: z.string().min(1).max(64).optional(),
  }),
  /** pid targets one of the connection's local players; omitted = primary. */
  z.object({ t: z.literal('input'), dir: DirectionSchema.nullable(), pid: PlayerIdSchema.optional() }),
  z.object({ t: z.literal('bomb'), pid: PlayerIdSchema.optional() }),
  z.object({ t: z.literal('start') }),
  /** pid targets one of the connection's local players; omitted = primary. */
  z.object({ t: z.literal('ready'), ready: z.boolean(), pid: PlayerIdSchema.optional() }),
  z.object({ t: z.literal('addBot'), difficulty: BotDifficultySchema.optional() }),
  /** Private rooms, host only, lobby only: resize between matches. */
  z.object({ t: z.literal('setSize'), size: RoomSizeSchema }),
  z.object({ t: z.literal('removeBot'), botId: PlayerIdSchema }),
  /** Private rooms, host only, lobby only: kick a player. Kicking any player
   *  on a connection removes every local player sharing it. */
  z.object({ t: z.literal('kick'), playerId: PlayerIdSchema }),
  /** Lobby only: add/remove/rename an extra local player on this connection. */
  z.object({ t: z.literal('addLocal'), nickname: NicknameSchema.optional() }),
  z.object({ t: z.literal('removeLocal'), playerId: PlayerIdSchema }),
  z.object({ t: z.literal('renameLocal'), playerId: PlayerIdSchema, nickname: NicknameSchema }),
  z.object({ t: z.literal('leave') }),
  /**
   * Branded-brick engagement signal: 'view' when the buyer's popup is revealed
   * to a player, 'click' when its VISIT link is opened. Counted only for bricks
   * actually placed in the sender's current match (server-side guarded).
   */
  z.object({
    t: z.literal('brickEvent'),
    id: z.string().min(1).max(64),
    kind: z.enum(['view', 'click']),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const PlayerSnapshotSchema = z.object({
  id: z.string(),
  x: z.number(),
  y: z.number(),
  dir: DirectionSchema.nullable(),
  alive: z.boolean(),
  bombCap: z.number().int(),
  range: z.number().int(),
  speed: z.number(),
});
export type PlayerSnapshot = z.infer<typeof PlayerSnapshotSchema>;

export const BombSnapshotSchema = z.object({
  id: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  ownerId: z.string(),
  explodesAt: z.number(),
});
export type BombSnapshot = z.infer<typeof BombSnapshotSchema>;

export const ExplosionSnapshotSchema = z.object({
  id: z.string(),
  cells: z.array(z.object({ x: z.number().int(), y: z.number().int() })),
  endsAt: z.number(),
});
export type ExplosionSnapshot = z.infer<typeof ExplosionSnapshotSchema>;

export const PowerupSnapshotSchema = z.object({
  id: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  kind: PowerupKindSchema,
});
export type PowerupSnapshot = z.infer<typeof PowerupSnapshotSchema>;

/** A branded crate cluster: tiles are image URLs, left to right from (x,y). */
export const BrickSnapshotSchema = z.object({
  id: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  tiles: z.array(z.string()),
  /** Buyer's brand label, shown in the hover/tap popup. */
  name: z.string(),
  /** Where the popup's "VISIT" action goes; null for bricks with no link. */
  link: z.string().nullable(),
});
export type BrickSnapshot = z.infer<typeof BrickSnapshotSchema>;

/** A sudden-death crush block whose warning is showing; it lands at `landsAt`. */
export const CrushWarningSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  landsAt: z.number(),
});
export type CrushWarning = z.infer<typeof CrushWarningSchema>;

export const RoomPlayerSchema = z.object({
  id: z.string(),
  nickname: z.string(),
  connected: z.boolean(),
  spectator: z.boolean(),
  /** Ready-check state; bots are always ready. */
  ready: z.boolean(),
  wins: z.number().int(),
  skin: SkinSchema.optional(),
  bot: z.boolean().optional(),
  /** Primary player id of the connection this local player belongs to. */
  ownerId: z.string().optional(),
});
export type RoomPlayer = z.infer<typeof RoomPlayerSchema>;

export const ErrorCodeSchema = z.enum([
  'room_not_found',
  'room_full',
  'password_required',
  'bad_password',
  'bad_message',
  'not_host',
  'cannot_start',
  'no_such_bot',
  'already_joined',
  'rejoin_failed',
  'not_allowed',
  'rate_limited',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ServerMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('joined'),
    playerId: z.string(),
    roomId: z.string(),
    roomName: z.string(),
    token: z.string(),
    isPrivate: z.boolean(),
    spectator: z.boolean(),
    /** Local players reattached with this connection (rejoin path). */
    localPlayerIds: z.array(z.string()).optional(),
  }),
  z.object({ t: z.literal('error'), code: ErrorCodeSchema, message: z.string() }),
  z.object({
    t: z.literal('room'),
    roomId: z.string(),
    roomName: z.string(),
    state: RoomStateSchema,
    isPrivate: z.boolean(),
    /** Always null for public rooms - they are hostless. */
    hostId: z.string().nullable(),
    maxPlayers: z.number().int(),
    /** Pre-match countdown or round-end deadline, depending on state. */
    countdownEndsAt: z.number().nullable(),
    winnerId: z.string().nullable(),
    /** Public rooms: anti-stall deadline; the match force-starts at this time. */
    readyTimerEndsAt: z.number().nullable(),
    serverTime: z.number(),
    players: z.array(RoomPlayerSchema),
  }),
  z.object({
    t: z.literal('snapshot'),
    tick: z.number().int(),
    serverTime: z.number(),
    grid: z.string(),
    players: z.array(PlayerSnapshotSchema),
    bombs: z.array(BombSnapshotSchema),
    explosions: z.array(ExplosionSnapshotSchema),
    powerups: z.array(PowerupSnapshotSchema),
    /**
     * Branded crate clusters. Constant for a whole round, so the server sends
     * them only on keyframe snapshots (round start, and after a join/rejoin);
     * other ticks omit the field and the client carries the last value forward.
     */
    bricks: z.array(BrickSnapshotSchema).optional(),
    /** Server time at which sudden death begins (clients show the countdown). */
    suddenDeathAt: z.number().optional(),
    /** Tiles currently telegraphing an incoming crush block. */
    crush: z.array(CrushWarningSchema).optional(),
    /**
     * Bot-only endgame: server time at which the round is force-resolved (one
     * bot crowned, the rest killed) because no humans are left alive. Present
     * once the finale is armed; clients show a countdown over its final
     * BOT_FINALE_COUNTDOWN_MS.
     */
    botFinaleAt: z.number().optional(),
  }),
  z.object({
    t: z.literal('afk'),
    /** Which of the connection's players the warning is about. */
    playerId: z.string(),
    /** Server time at which the player will be kicked; null clears the warning. */
    kickAt: z.number().nullable(),
  }),
  /** host kicks remove the whole connection; playerId is the primary player. */
  z.object({ t: z.literal('kicked'), reason: z.enum(['afk', 'host']), playerId: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type SnapshotMessage = Extract<ServerMessage, { t: 'snapshot' }>;
export type RoomMessage = Extract<ServerMessage, { t: 'room' }>;
export type JoinedMessage = Extract<ServerMessage, { t: 'joined' }>;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function parseClientMessage(raw: string): ClientMessage | null {
  const result = ClientMessageSchema.safeParse(parseJson(raw));
  return result.success ? result.data : null;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  const result = ServerMessageSchema.safeParse(parseJson(raw));
  return result.success ? result.data : null;
}
