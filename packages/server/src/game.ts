import {
  BASE_SPEED,
  BOMB_FUSE_MS,
  CRUSH_INTERVAL_MS,
  CRUSH_WARNING_MS,
  DEFAULT_BOMB_CAP,
  DEFAULT_RANGE,
  DEFAULT_ROOM_SIZE_DESKTOP,
  EXPLOSION_DURATION_MS,
  MAX_BOMB_CAP,
  MAX_RANGE,
  MAX_SPEED,
  PLAYER_RADIUS,
  POWERUP_DROP_CHANCE,
  SPEED_INCREMENT,
  SUDDEN_DEATH_AFTER_MS,
  TILE_CRATE,
  TILE_CRUSH,
  TILE_EMPTY,
  TILE_WALL,
  crushSpiral,
  generateMap,
  gridDims,
  spawnPoints,
  type BombSnapshot,
  type Cell,
  type CrushWarning,
  type Direction,
  type ExplosionSnapshot,
  type BrickSnapshot,
  type PlayerSnapshot,
  type PowerupKind,
  type PowerupSnapshot,
  type RoomSize,
} from '@blastmates/shared';
import { placeBricks, type BrickCandidate, type PlacedBrick } from './bricks';

/** Perpendicular offset (in tiles) beyond which a blocked turn is steered
 *  into the adjacent open lane instead of pressing into the wall. */
const CORNER_ASSIST = 0.15;

export interface GamePlayer {
  id: string;
  x: number;
  y: number;
  dir: Direction | null;
  alive: boolean;
  bombCap: number;
  range: number;
  speed: number;
}

export interface Bomb {
  id: string;
  cx: number;
  cy: number;
  ownerId: string;
  range: number;
  explodesAt: number;
  /** Players still allowed to overlap this bomb (standing on it when placed). */
  passable: string[];
}

export interface Explosion {
  id: string;
  cells: Cell[];
  endsAt: number;
}

export interface Powerup {
  id: string;
  cx: number;
  cy: number;
  kind: PowerupKind;
}

/** Sudden-death tuning; lives in the room/match config. */
export interface SuddenDeathConfig {
  /** Match time before sudden death begins. */
  afterMs?: number;
  /** Cadence between crush block landings. */
  intervalMs?: number;
  /** Warning overlay lead time before each landing. */
  warningMs?: number;
}

export interface GameOptions {
  rng?: () => number;
  /** Room size; the map dimensions and spawn layout derive from it. */
  size?: RoomSize;
  grid?: Uint8Array;
  /** Pre-selected branded bricks to place as crate clusters. */
  bricks?: BrickCandidate[];
  suddenDeath?: SuddenDeathConfig;
}

export interface BrickRoundStats {
  appearances: number;
  tilesDestroyed: number;
  fullyDestroyed: number;
}

const POWERUP_KINDS: readonly PowerupKind[] = ['bomb', 'range', 'speed'];

/**
 * Pure authoritative simulation of one round. All timing comes in via
 * explicit `now` parameters so tests can drive it deterministically.
 */
export class Game {
  /** Room size this round was generated for. */
  readonly size: RoomSize;
  /** Map dimensions in tiles, derived from the room size. */
  readonly width: number;
  readonly height: number;
  readonly grid: Uint8Array;
  readonly players = new Map<string, GamePlayer>();
  bombs: Bomb[] = [];
  explosions: Explosion[] = [];
  powerups: Powerup[] = [];
  /** Branded crate clusters placed this round. */
  readonly placedBricks: PlacedBrick[];
  /** cell index -> brick id, for destruction stats. */
  private readonly brickCells = new Map<number, string>();
  private readonly brickTilesDestroyed = new Map<string, number>();

  private readonly rng: () => number;
  private nextId = 0;

  /** Spiral landing order for sudden-death crush blocks. */
  private readonly crushOrder: Cell[];
  private readonly sdAfterMs: number;
  private readonly crushIntervalMs: number;
  private readonly crushWarningMs: number;
  /** Set on the first update; sudden death begins sdAfterMs later. */
  private startedAt: number | null = null;
  /** False until the start condition (>= 2 players alive) is met. */
  private crushActive = false;
  private crushLanded = 0;

  constructor(playerIds: string[], opts: GameOptions = {}) {
    this.rng = opts.rng ?? Math.random;
    this.size = opts.size ?? DEFAULT_ROOM_SIZE_DESKTOP;
    const dims = gridDims(this.size);
    this.width = dims.width;
    this.height = dims.height;
    this.grid = opts.grid ?? generateMap(this.size, this.rng);
    this.sdAfterMs = opts.suddenDeath?.afterMs ?? SUDDEN_DEATH_AFTER_MS;
    this.crushIntervalMs = opts.suddenDeath?.intervalMs ?? CRUSH_INTERVAL_MS;
    this.crushWarningMs = opts.suddenDeath?.warningMs ?? CRUSH_WARNING_MS;
    this.crushOrder = crushSpiral(this.width, this.height);
    this.placedBricks = opts.bricks ? placeBricks(this.grid, this.size, opts.bricks, this.rng) : [];
    for (const placed of this.placedBricks) {
      for (let i = 0; i < placed.size; i++) {
        this.brickCells.set(this.idx(placed.x + i, placed.y), placed.id);
      }
    }
    const spawns = spawnPoints(this.size);
    playerIds.slice(0, spawns.length).forEach((id, i) => {
      const corner = spawns[i];
      if (!corner) return;
      this.players.set(id, {
        id,
        x: corner.x + 0.5,
        y: corner.y + 0.5,
        dir: null,
        alive: true,
        bombCap: DEFAULT_BOMB_CAP,
        range: DEFAULT_RANGE,
        speed: BASE_SPEED,
      });
    });
  }

  private newId(prefix: string): string {
    return `${prefix}${++this.nextId}`;
  }

  /** Flat tile index in this game's grid. */
  idx(x: number, y: number): number {
    return y * this.width + x;
  }

  /** True when (x, y) lies inside this game's grid. */
  contains(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  setInput(playerId: string, dir: Direction | null): void {
    const p = this.players.get(playerId);
    if (p && p.alive) p.dir = dir;
  }

  placeBomb(playerId: string, now: number): boolean {
    const p = this.players.get(playerId);
    if (!p || !p.alive) return false;
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    if (this.bombAt(cx, cy)) return false;
    const active = this.bombs.filter((b) => b.ownerId === playerId).length;
    if (active >= p.bombCap) return false;
    const passable: string[] = [];
    for (const other of this.players.values()) {
      if (other.alive && Math.floor(other.x) === cx && Math.floor(other.y) === cy) {
        passable.push(other.id);
      }
    }
    this.bombs.push({
      id: this.newId('b'),
      cx,
      cy,
      ownerId: playerId,
      range: p.range,
      explodesAt: now + BOMB_FUSE_MS,
      passable,
    });
    return true;
  }

  killPlayer(playerId: string): void {
    const p = this.players.get(playerId);
    if (p) {
      p.alive = false;
      p.dir = null;
    }
  }

  alivePlayers(): GamePlayer[] {
    return [...this.players.values()].filter((p) => p.alive);
  }

  update(now: number, dtMs: number): void {
    if (this.startedAt === null) this.startedAt = now;
    const dt = dtMs / 1000;
    for (const p of this.players.values()) {
      if (p.alive) this.movePlayer(p, dt);
    }

    // A bomb stays passable for a player only while they remain on its tile.
    for (const bomb of this.bombs) {
      bomb.passable = bomb.passable.filter((id) => {
        const p = this.players.get(id);
        return p !== undefined && Math.floor(p.x) === bomb.cx && Math.floor(p.y) === bomb.cy;
      });
    }

    // Crush blocks land before detonation: a crushed bomb never explodes.
    this.updateCrush(now);

    const due = this.bombs.filter((b) => b.explodesAt <= now);
    if (due.length > 0) this.detonate(due, now);

    this.explosions = this.explosions.filter((e) => e.endsAt > now);

    for (const explosion of this.explosions) {
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const px = Math.floor(p.x);
        const py = Math.floor(p.y);
        if (explosion.cells.some((c) => c.x === px && c.y === py)) {
          this.killPlayer(p.id);
        }
      }
    }

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const px = Math.floor(p.x);
      const py = Math.floor(p.y);
      const idx = this.powerups.findIndex((u) => u.cx === px && u.cy === py);
      if (idx >= 0) {
        const powerup = this.powerups[idx];
        if (powerup) this.applyPowerup(p, powerup.kind);
        this.powerups.splice(idx, 1);
      }
    }
  }

  /** Server time at which sudden death begins (known once the round runs). */
  get suddenDeathAt(): number | null {
    return this.startedAt === null ? null : this.startedAt + this.sdAfterMs;
  }

  private crushLandAt(i: number): number {
    return (this.suddenDeathAt ?? 0) + this.crushWarningMs + i * this.crushIntervalMs;
  }

  private updateCrush(now: number): void {
    const sdAt = this.suddenDeathAt;
    if (sdAt === null || now < sdAt) return;
    // With <=1 player alive the round is over anyway: end the match normally
    // instead of starting the shrink.
    if (!this.crushActive) {
      if (this.alivePlayers().length < 2) return;
      this.crushActive = true;
    }
    while (this.crushLanded < this.crushOrder.length && this.crushLandAt(this.crushLanded) <= now) {
      const cell = this.crushOrder[this.crushLanded++];
      if (cell) this.landCrushBlock(cell);
    }
  }

  private landCrushBlock(cell: Cell): void {
    const idx = this.idx(cell.x, cell.y);
    this.grid[idx] = TILE_CRUSH;
    // A crushed bomb is removed without exploding; powerups and crates vanish.
    this.bombs = this.bombs.filter((b) => b.cx !== cell.x || b.cy !== cell.y);
    this.powerups = this.powerups.filter((u) => u.cx !== cell.x || u.cy !== cell.y);
    this.brickCells.delete(idx);
    for (const p of this.players.values()) {
      // Environment kill via the same death pipeline as bomb kills, no credit.
      if (p.alive && Math.floor(p.x) === cell.x && Math.floor(p.y) === cell.y) {
        this.killPlayer(p.id);
      }
    }
  }

  /** Blocks not yet landed whose warning window has begun, oldest first. */
  crushWarnings(now: number): CrushWarning[] {
    if (!this.crushActive) return [];
    const out: CrushWarning[] = [];
    for (let i = this.crushLanded; i < this.crushOrder.length; i++) {
      const landsAt = this.crushLandAt(i);
      if (landsAt - this.crushWarningMs > now) break;
      const cell = this.crushOrder[i];
      if (cell) out.push({ x: cell.x, y: cell.y, landsAt });
    }
    return out;
  }

  /** Upcoming crush landings within horizonMs, keyed by tile index (bot AI). */
  crushThreats(now: number, horizonMs: number): Map<number, number> {
    const threats = new Map<number, number>();
    if (!this.crushActive) return threats;
    for (let i = this.crushLanded; i < this.crushOrder.length; i++) {
      const landsAt = this.crushLandAt(i);
      if (landsAt > now + horizonMs) break;
      const cell = this.crushOrder[i];
      if (cell) threats.set(this.idx(cell.x, cell.y), landsAt);
    }
    return threats;
  }

  private applyPowerup(p: GamePlayer, kind: PowerupKind): void {
    if (kind === 'bomb') p.bombCap = Math.min(MAX_BOMB_CAP, p.bombCap + 1);
    else if (kind === 'range') p.range = Math.min(MAX_RANGE, p.range + 1);
    else p.speed = Math.min(MAX_SPEED, p.speed + SPEED_INCREMENT);
  }

  bombAt(cx: number, cy: number): Bomb | undefined {
    return this.bombs.find((b) => b.cx === cx && b.cy === cy);
  }

  private isSolidFor(playerId: string, cx: number, cy: number): boolean {
    if (!this.contains(cx, cy)) return true;
    const tile = this.grid[this.idx(cx, cy)];
    if (tile === TILE_WALL || tile === TILE_CRATE || tile === TILE_CRUSH) return true;
    const bomb = this.bombAt(cx, cy);
    if (bomb && !bomb.passable.includes(playerId)) return true;
    return false;
  }

  /**
   * Grid-locked movement: while moving along one axis the player is first
   * pulled to the centre of their current lane, then advances and is clamped
   * against the next solid cell.
   */
  private movePlayer(p: GamePlayer, dt: number): void {
    // Sub-step so a large dt can never tunnel through a solid cell.
    let total = p.speed * dt;
    while (total > 1e-9 && p.dir) {
      const step = Math.min(total, 0.4);
      this.moveStep(p, step);
      total -= step;
    }
  }

  /**
   * Corner assist: when the cell ahead in the player's own lane is solid but
   * they are leaning into a neighbouring lane whose path is clear, steer the
   * alignment pull into that lane. Without this, a slightly-late turn at an
   * intersection presses into the wall and reads as dropped input.
   */
  private laneCenterFor(p: GamePlayer, horizontal: boolean, sign: number): number {
    if (horizontal) {
      const lane = Math.floor(p.y);
      const ahead = Math.floor(p.x) + sign;
      const offset = p.y - (lane + 0.5);
      const neighbor = lane + Math.sign(offset);
      if (
        Math.abs(offset) > CORNER_ASSIST &&
        this.isSolidFor(p.id, ahead, lane) &&
        !this.isSolidFor(p.id, Math.floor(p.x), neighbor) &&
        !this.isSolidFor(p.id, ahead, neighbor)
      ) {
        return neighbor + 0.5;
      }
      return lane + 0.5;
    }
    const lane = Math.floor(p.x);
    const ahead = Math.floor(p.y) + sign;
    const offset = p.x - (lane + 0.5);
    const neighbor = lane + Math.sign(offset);
    if (
      Math.abs(offset) > CORNER_ASSIST &&
      this.isSolidFor(p.id, lane, ahead) &&
      !this.isSolidFor(p.id, neighbor, Math.floor(p.y)) &&
      !this.isSolidFor(p.id, neighbor, ahead)
    ) {
      return neighbor + 0.5;
    }
    return lane + 0.5;
  }

  private moveStep(p: GamePlayer, distance: number): void {
    if (!p.dir) return;
    let remaining = distance;
    const horizontal = p.dir === 'left' || p.dir === 'right';
    const sign = p.dir === 'right' || p.dir === 'down' ? 1 : -1;

    if (horizontal) {
      const laneCenter = this.laneCenterFor(p, true, sign);
      const align = laneCenter - p.y;
      if (align !== 0) {
        const step = Math.sign(align) * Math.min(Math.abs(align), remaining);
        p.y += step;
        remaining -= Math.abs(step);
      }
      if (remaining <= 0) return;
      let newX = p.x + sign * remaining;
      const frontCell = Math.floor(newX + sign * PLAYER_RADIUS);
      if (frontCell !== Math.floor(p.x) && this.isSolidFor(p.id, frontCell, Math.floor(p.y))) {
        newX = sign > 0 ? frontCell - PLAYER_RADIUS : frontCell + 1 + PLAYER_RADIUS;
      }
      p.x = Math.min(Math.max(newX, PLAYER_RADIUS), this.width - PLAYER_RADIUS);
    } else {
      const laneCenter = this.laneCenterFor(p, false, sign);
      const align = laneCenter - p.x;
      if (align !== 0) {
        const step = Math.sign(align) * Math.min(Math.abs(align), remaining);
        p.x += step;
        remaining -= Math.abs(step);
      }
      if (remaining <= 0) return;
      let newY = p.y + sign * remaining;
      const frontCell = Math.floor(newY + sign * PLAYER_RADIUS);
      if (frontCell !== Math.floor(p.y) && this.isSolidFor(p.id, Math.floor(p.x), frontCell)) {
        newY = sign > 0 ? frontCell - PLAYER_RADIUS : frontCell + 1 + PLAYER_RADIUS;
      }
      p.y = Math.min(Math.max(newY, PLAYER_RADIUS), this.height - PLAYER_RADIUS);
    }
  }

  /** Detonate the given bombs plus everything they chain into, as one blast. */
  private detonate(due: Bomb[], now: number): void {
    const exploded = new Set<string>();
    const queue = [...due];
    const cellSet = new Map<number, Cell>();
    const crateCells: Cell[] = [];
    const destroyedPowerups = new Set<string>();

    const addCell = (x: number, y: number): void => {
      cellSet.set(this.idx(x, y), { x, y });
    };

    while (queue.length > 0) {
      const bomb = queue.pop();
      if (!bomb || exploded.has(bomb.id)) continue;
      exploded.add(bomb.id);
      addCell(bomb.cx, bomb.cy);

      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        for (let r = 1; r <= bomb.range; r++) {
          const x = bomb.cx + dx * r;
          const y = bomb.cy + dy * r;
          if (!this.contains(x, y)) break;
          const idx = this.idx(x, y);
          const tile = this.grid[idx];
          if (tile === TILE_WALL || tile === TILE_CRUSH) break;
          if (tile === TILE_CRATE) {
            // Crate absorbs the blast: destroyed, ray stops.
            this.grid[idx] = TILE_EMPTY;
            addCell(x, y);
            crateCells.push({ x, y });
            const brickId = this.brickCells.get(idx);
            if (brickId !== undefined) {
              this.brickCells.delete(idx);
              this.brickTilesDestroyed.set(
                brickId,
                (this.brickTilesDestroyed.get(brickId) ?? 0) + 1,
              );
            }
            break;
          }
          addCell(x, y);
          const chained = this.bombAt(x, y);
          if (chained && !exploded.has(chained.id)) {
            queue.push(chained);
            break;
          }
          const powerup = this.powerups.find((u) => u.cx === x && u.cy === y);
          if (powerup) {
            destroyedPowerups.add(powerup.id);
            break;
          }
        }
      }
    }

    this.bombs = this.bombs.filter((b) => !exploded.has(b.id));
    this.powerups = this.powerups.filter((u) => !destroyedPowerups.has(u.id));

    // Powerups revealed by this blast appear after it, so they survive it.
    for (const cell of crateCells) {
      if (this.rng() < POWERUP_DROP_CHANCE) {
        const kind = POWERUP_KINDS[Math.floor(this.rng() * POWERUP_KINDS.length)] ?? 'bomb';
        this.powerups.push({ id: this.newId('u'), cx: cell.x, cy: cell.y, kind });
      }
    }

    this.explosions.push({
      id: this.newId('e'),
      cells: [...cellSet.values()],
      endsAt: now + EXPLOSION_DURATION_MS,
    });
  }

  playerSnapshots(): PlayerSnapshot[] {
    // Positions are quantised to 1/100 tile for the wire: the simulation keeps
    // full f64 precision, but transmitting it verbatim spends ~18 chars per
    // coordinate on sub-pixel noise that the client's interpolation throws away.
    // Two decimals is well under a pixel at any sane tile size and compresses
    // far better than a long mantissa.
    return [...this.players.values()].map((p) => ({
      id: p.id,
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      dir: p.dir,
      alive: p.alive,
      bombCap: p.bombCap,
      range: p.range,
      speed: p.speed,
    }));
  }

  bombSnapshots(): BombSnapshot[] {
    return this.bombs.map((b) => ({
      id: b.id,
      x: b.cx,
      y: b.cy,
      ownerId: b.ownerId,
      explodesAt: b.explodesAt,
    }));
  }

  explosionSnapshots(): ExplosionSnapshot[] {
    return this.explosions.map((e) => ({ id: e.id, cells: e.cells, endsAt: e.endsAt }));
  }

  powerupSnapshots(): PowerupSnapshot[] {
    return this.powerups.map((u) => ({ id: u.id, x: u.cx, y: u.cy, kind: u.kind }));
  }

  brickSnapshots(): BrickSnapshot[] {
    return this.placedBricks.map((b) => ({
      id: b.id,
      x: b.x,
      y: b.y,
      tiles: b.tileUrls,
      name: b.name,
      link: b.link,
    }));
  }

  /** Per-brick stats for this round (appearance + destruction counts). */
  brickRoundStats(): Map<string, BrickRoundStats> {
    const stats = new Map<string, BrickRoundStats>();
    for (const placed of this.placedBricks) {
      const destroyed = this.brickTilesDestroyed.get(placed.id) ?? 0;
      stats.set(placed.id, {
        appearances: 1,
        tilesDestroyed: destroyed,
        fullyDestroyed: destroyed >= placed.size ? 1 : 0,
      });
    }
    return stats;
  }
}
