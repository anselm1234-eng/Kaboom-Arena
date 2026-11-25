import {
  BOMB_FUSE_MS,
  CRUSH_SAFE_SIZE,
  TILE_CRATE,
  TILE_CRUSH,
  TILE_WALL,
  type BotDifficulty,
  type Cell,
  type Direction,
} from '@blastmates/shared';
import type { Game, GamePlayer } from './game';

/** Names assigned randomly to bots, never duplicated within one room. */
export const BOT_NAMES: readonly string[] = [
  'Bombo',
  'Kaboomka',
  'Lil Fuse',
  'Boomer',
  'Sir Blastalot',
  'Sparky',
  'Short Fuse',
  'Detonado',
];

interface Dir {
  dir: Direction;
  dx: number;
  dy: number;
}

const DIRS: readonly Dir[] = [
  { dir: 'up', dx: 0, dy: -1 },
  { dir: 'down', dx: 0, dy: 1 },
  { dir: 'left', dx: -1, dy: 0 },
  { dir: 'right', dx: 1, dy: 0 },
];

const OPPOSITE: Record<Direction, Direction> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

export interface BotDecision {
  dir: Direction | null;
  bomb: boolean;
}

/**
 * Per-difficulty knobs. The same brain drives both tiers; these dials make
 * `easy` visibly weaker (slower reflexes, no hunting, the odd random step)
 * without ever making it look broken (it still flees blasts every tick).
 */
interface BrainParams {
  /** Actively chase enemies into a firing line (vs. only farm + survive). */
  hunt: boolean;
  /** Walk out of the way to grab powerups. */
  collectPowerups: boolean;
  /** Re-plan a fresh objective only every Nth tick (reaction delay). */
  reactEvery: number;
  /** Chance per planned move to wander a random safe direction instead. */
  randomMove: number;
  /** How close (Manhattan) an enemy must be before we stop farming to fight. */
  engageRange: number;
}

const PARAMS: Record<BotDifficulty, BrainParams> = {
  easy: { hunt: false, collectPowerups: true, reactEvery: 3, randomMove: 0.18, engageRange: 0 },
  normal: { hunt: true, collectPowerups: true, reactEvery: 1, randomMove: 0, engageRange: 6 },
};

/**
 * How far ahead bots see scheduled crush landings. Longer than the player
 * warning so they retreat toward the safe area before the wave reaches them.
 */
const CRUSH_LOOKAHEAD_MS = 3_000;

/** Don't detour further than this (in tiles) to collect a powerup. */
const POWERUP_DETOUR = 7;

/** Add every cell a bomb at (cx, cy) would cover; crates absorb the ray. */
function addBlastCells(game: Game, cx: number, cy: number, range: number, out: Set<number>): void {
  out.add(game.idx(cx, cy));
  for (const { dx, dy } of DIRS) {
    for (let r = 1; r <= range; r++) {
      const x = cx + dx * r;
      const y = cy + dy * r;
      if (!game.contains(x, y)) break;
      const tile = game.grid[game.idx(x, y)];
      if (tile === TILE_WALL || tile === TILE_CRUSH) break;
      out.add(game.idx(x, y));
      if (tile === TILE_CRATE) break;
    }
  }
}

/**
 * Earliest detonation time per threatened cell, accounting for chain
 * reactions (a bomb caught in an earlier blast goes off at that time too).
 */
function bombThreats(game: Game): Map<number, number> {
  const blasts = game.bombs.map((b) => {
    const cells = new Set<number>();
    addBlastCells(game, b.cx, b.cy, b.range, cells);
    return { b, cells, at: b.explodesAt };
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of blasts) {
      for (const other of blasts) {
        if (a !== other && a.at < other.at && a.cells.has(game.idx(other.b.cx, other.b.cy))) {
          other.at = a.at;
          changed = true;
        }
      }
    }
  }
  const threats = new Map<number, number>();
  for (const { cells, at } of blasts) {
    for (const idx of cells) {
      const cur = threats.get(idx);
      if (cur === undefined || at < cur) threats.set(idx, at);
    }
  }
  return threats;
}

/** Cells that kill on contact right now (active explosions only). */
function lethalCells(game: Game): Set<number> {
  const lethal = new Set<number>();
  for (const explosion of game.explosions) {
    for (const cell of explosion.cells) lethal.add(game.idx(cell.x, cell.y));
  }
  return lethal;
}

function walkable(game: Game, botId: string, x: number, y: number): boolean {
  if (!game.contains(x, y)) return false;
  const tile = game.grid[game.idx(x, y)];
  if (tile === TILE_WALL || tile === TILE_CRATE || tile === TILE_CRUSH) return false;
  const bomb = game.bombAt(x, y);
  if (bomb && !bomb.passable.includes(botId)) return false;
  return true;
}

interface PathResult {
  firstStep: Cell;
  /** The cell that satisfied the goal (where the path ends). */
  goal: number;
  length: number;
}

/**
 * Shortest path from (sx, sy) to any cell satisfying `goal`, entering only
 * cells `canEnter` allows (depth = steps from the start, so callers can
 * reject cells that will explode before the bot can get there). Returns the
 * first step to take (or the start itself when it already satisfies the goal).
 */
function findPath(
  game: Game,
  botId: string,
  sx: number,
  sy: number,
  goal: (idx: number) => boolean,
  canEnter: (idx: number, depth: number) => boolean,
  order: readonly Dir[],
): PathResult | null {
  const start = game.idx(sx, sy);
  if (goal(start)) return { firstStep: { x: sx, y: sy }, goal: start, length: 0 };
  const cameFrom = new Map<number, number>();
  cameFrom.set(start, start);
  const queue: Array<Cell & { depth: number }> = [{ x: sx, y: sy, depth: 0 }];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur) break;
    for (const { dx, dy } of order) {
      const x = cur.x + dx;
      const y = cur.y + dy;
      const idx = game.idx(x, y);
      if (cameFrom.has(idx) || !walkable(game, botId, x, y) || !canEnter(idx, cur.depth + 1)) {
        continue;
      }
      cameFrom.set(idx, game.idx(cur.x, cur.y));
      if (goal(idx)) {
        // Walk back to the cell right after the start.
        let at = idx;
        let length = 1;
        while (cameFrom.get(at) !== start) {
          at = cameFrom.get(at) ?? start;
          length++;
        }
        return { firstStep: { x: at % game.width, y: Math.floor(at / game.width) }, goal: idx, length };
      }
      queue.push({ x, y, depth: cur.depth + 1 });
    }
  }
  return null;
}

/** Count of safe, walkable cells reachable from (x, y), capped at `cap`. */
function safeAreaSize(
  game: Game,
  botId: string,
  x: number,
  y: number,
  safe: (idx: number) => boolean,
  cap: number,
): number {
  const start = game.idx(x, y);
  const seen = new Set<number>([start]);
  const queue: Cell[] = [{ x, y }];
  let count = 0;
  while (queue.length > 0 && count < cap) {
    const cur = queue.shift();
    if (!cur) break;
    count++;
    for (const { dx, dy } of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const idx = game.idx(nx, ny);
      if (seen.has(idx) || !walkable(game, botId, nx, ny) || !safe(idx)) continue;
      seen.add(idx);
      queue.push({ x: nx, y: ny });
    }
  }
  return count;
}

/**
 * Server-side bot brain. Produces one decision per tick; the room feeds it
 * through the same handleInput/handleBomb entry points human messages use.
 *
 * The brain is a prioritised behaviour tree evaluated every tick:
 *   1. Survive  — standing in danger: flee to the nearest cell safe in time.
 *   2. Strike   — an enemy sits in our blast and we have a safe getaway: bomb.
 *   3. Hunt     — path toward a cell from which we could bomb an enemy.
 *   4. Collect  — detour to a nearby powerup.
 *   5. Farm     — break crates to open lanes and reveal powerups.
 *   6. Reposition — close on the nearest enemy / drift to open space.
 * Movement uses a danger-aware shortest path with deterministic tie-breaking
 * biased toward continuing the current heading, so bots stop zig-zagging.
 */
export class BotController {
  private readonly params: BrainParams;
  /** Last direction issued, used to bias pathing and persist headings. */
  private lastDir: Direction | null = null;
  /** Reaction-delay counter: when >0 we repeat lastDir instead of re-planning. */
  private coast = 0;

  constructor(
    readonly playerId: string,
    readonly difficulty: BotDifficulty,
    private readonly rng: () => number = Math.random,
  ) {
    this.params = PARAMS[difficulty] ?? PARAMS.normal;
  }

  /** Clear per-round state (called when a fresh round starts). */
  reset(): void {
    this.lastDir = null;
    this.coast = 0;
  }

  update(game: Game, now: number): BotDecision {
    const me = game.players.get(this.playerId);
    if (!me || !me.alive) return { dir: null, bomb: false };
    const cx = Math.floor(me.x);
    const cy = Math.floor(me.y);
    const here = game.idx(cx, cy);

    const threats = bombThreats(game);
    // Scheduled crush landings feed the same threat map as bomb blasts, so
    // the existing avoidance/escape logic also flees the shrinking edge.
    for (const [idx, at] of game.crushThreats(now, CRUSH_LOOKAHEAD_MS)) {
      const cur = threats.get(idx);
      if (cur === undefined || at < cur) threats.set(idx, at);
    }
    const lethal = lethalCells(game);
    // Worst-case time to cross one tile, plus slack for lane alignment.
    const msPerTile = 1000 / me.speed;
    const margin = msPerTile + 150;
    const safe = (i: number): boolean => !threats.has(i) && !lethal.has(i);
    /** Enter a threatened cell only if we'll be through before it blows. */
    const inTime = (i: number, depth: number): boolean => {
      if (lethal.has(i)) return false;
      const at = threats.get(i);
      return at === undefined || at > now + depth * msPerTile + margin;
    };

    // 1. SURVIVE. Standing in a blast zone: head for the nearest safe cell,
    //    crossing only cells we can clear before they detonate. If no such
    //    route exists, gamble on the shortest route rather than freezing.
    //    This reflex runs every tick regardless of difficulty/reaction delay.
    if (!safe(here)) {
      this.coast = 0;
      const escape =
        findPath(game, this.playerId, cx, cy, safe, inTime, this.order()) ??
        findPath(game, this.playerId, cx, cy, safe, (i) => !lethal.has(i), this.order());
      return this.commit(escape ? this.stepDir(cx, cy, escape.firstStep) : null, false);
    }

    // Reaction delay (easy bots): between re-plans, keep coasting along the
    // last heading as long as that step stays safe. Cheap way to look human.
    if (this.coast > 0 && this.lastDir) {
      const ahead = this.neighbour(cx, cy, this.lastDir);
      if (ahead && walkable(game, this.playerId, ahead.x, ahead.y) && safe(game.idx(ahead.x, ahead.y))) {
        this.coast--;
        return { dir: this.lastDir, bomb: false };
      }
    }
    this.coast = this.params.reactEvery - 1;

    const enemies = [...game.players.values()].filter((p) => p.alive && p.id !== this.playerId);
    const enemyNear = enemies.some(
      (e) => Math.abs(Math.floor(e.x) - cx) + Math.abs(Math.floor(e.y) - cy) <= this.params.engageRange,
    );

    // A live enemy bomb in our local area makes bombing reckless: its blast (or
    // the bomb tile itself, which is solid to us) can seal off the very escape
    // we'd rely on. Hold our bomb until the area clears — survival first.
    const contested = this.enemyBombNear(game, me, cx, cy);

    // 2. STRIKE. An enemy is already in our blast and we can place-and-flee:
    //    nothing beats a free kill, so this outranks every movement goal.
    if (!contested && this.canBomb(game, me, cx, cy) && this.blastHitsEnemy(game, me, cx, cy, enemies)) {
      const escape = this.bombEscape(game, me, cx, cy, now, safe, inTime, margin, msPerTile);
      if (escape) return this.commit(this.stepDir(cx, cy, escape.firstStep), true);
    }

    // 2b. RETREAT. The perimeter is a death trap once the arena shrinks: on the
    //     top/bottom rows you can only run *along* the sweep, which is faster
    //     than you. So head into the central safe square and arrive before the
    //     spiral does. We leave "just in time" — when the ETA to the centre
    //     equals the time left before sudden death — to keep farming until then.
    const sdAt = game.suddenDeathAt;
    if (sdAt !== null && !this.inSafeArea(game, cx, cy)) {
      const toCenter = findPath(
        game,
        this.playerId,
        cx,
        cy,
        (i) => this.inSafeArea(game, i % game.width, Math.floor(i / game.width)),
        inTime,
        this.order(),
      );
      if (toCenter && toCenter.length > 0) {
        // Generous buffer: real paths weave around crates and we must beat the
        // sweep, not just arrive as it lands.
        const eta = toCenter.length * msPerTile * 1.5 + 1_000;
        if (now >= sdAt - eta) return this.commit(this.stepDir(cx, cy, toCenter.firstStep), false);
      }
    }

    // Occasional aimless step (easy only) so it reads as a fallible opponent.
    if (this.params.randomMove > 0 && this.rng() < this.params.randomMove) {
      const wander = this.randomSafeStep(game, cx, cy, safe);
      if (wander) return this.commit(wander, false);
    }

    // 3. HUNT. Once an enemy is within engage range, walk toward a cell from
    //    which a bomb would catch it. When we arrive in line, step 2 fires on
    //    the next tick. While enemies are far we'd rather power up (steps 4-5).
    if (this.params.hunt && enemyNear) {
      const attack = findPath(
        game,
        this.playerId,
        cx,
        cy,
        (i) => this.isAttackCell(game, me, i, enemies),
        inTime,
        this.order(),
      );
      if (attack && attack.length > 0) return this.commit(this.stepDir(cx, cy, attack.firstStep), false);
    }

    // 4. COLLECT. Detour to a nearby powerup (bounded so we never ignore a
    //    fight for a far trinket).
    if (this.params.collectPowerups && game.powerups.length > 0) {
      const grab = findPath(
        game,
        this.playerId,
        cx,
        cy,
        (i) => game.powerups.some((u) => game.idx(u.cx, u.cy) === i),
        inTime,
        this.order(),
      );
      if (grab && grab.length > 0 && grab.length <= POWERUP_DETOUR) {
        return this.commit(this.stepDir(cx, cy, grab.firstStep), false);
      }
    }

    // 5. FARM. Break crates to open lanes and reveal powerups. Skip when an
    //    enemy is close enough to fight (don't spend our one bomb on a crate
    //    while a kill is in reach) — unless we're boxed in and must dig out.
    const blockedIn = this.params.hunt && enemyNear ? this.huntPathBlocked(game, me, cx, cy, enemies, safe) : false;
    if (!enemyNear || blockedIn) {
      if (!contested && this.canBomb(game, me, cx, cy) && this.blastHitsCrate(game, me, cx, cy)) {
        const escape = this.bombEscape(game, me, cx, cy, now, safe, inTime, margin, msPerTile);
        if (escape) return this.commit(this.stepDir(cx, cy, escape.firstStep), true);
      }
      const farm = findPath(
        game,
        this.playerId,
        cx,
        cy,
        (i) => this.adjacentToCrate(game, i),
        inTime,
        this.order(),
      );
      if (farm && farm.length > 0) return this.commit(this.stepDir(cx, cy, farm.firstStep), false);
    }

    // 6. REPOSITION. Nothing actionable in reach: close on the nearest enemy
    //    when hunting, otherwise drift to a roomy safe neighbour.
    if (this.params.hunt && enemies.length > 0) {
      const close = findPath(
        game,
        this.playerId,
        cx,
        cy,
        (i) => enemies.some((e) => game.idx(Math.floor(e.x), Math.floor(e.y)) === i),
        inTime,
        this.order(),
      );
      if (close && close.length > 0) return this.commit(this.stepDir(cx, cy, close.firstStep), false);
    }
    return this.commit(this.bestDrift(game, cx, cy, safe), false);
  }

  /**
   * Direction exploration order for BFS tie-breaking: try the current heading
   * first and its opposite last. Deterministic, so equal-length routes don't
   * flip frame to frame (the old random reshuffle was the main wobble source).
   */
  private order(): readonly Dir[] {
    if (!this.lastDir) return DIRS;
    const opp = OPPOSITE[this.lastDir];
    const head = DIRS.filter((d) => d.dir === this.lastDir);
    const mid = DIRS.filter((d) => d.dir !== this.lastDir && d.dir !== opp);
    const back = DIRS.filter((d) => d.dir === opp);
    return [...head, ...mid, ...back];
  }

  /** Record the heading we issue so the next tick can bias toward it. */
  private commit(dir: Direction | null, bomb: boolean): BotDecision {
    if (dir) this.lastDir = dir;
    return { dir, bomb };
  }

  private neighbour(cx: number, cy: number, dir: Direction): Cell | null {
    const d = DIRS.find((o) => o.dir === dir);
    return d ? { x: cx + d.dx, y: cy + d.dy } : null;
  }

  private stepDir(cx: number, cy: number, target: Cell): Direction | null {
    if (target.x > cx) return 'right';
    if (target.x < cx) return 'left';
    if (target.y > cy) return 'down';
    if (target.y < cy) return 'up';
    return null;
  }

  /** Is a live enemy bomb close enough that bombing now risks a sealed escape? */
  private enemyBombNear(game: Game, me: GamePlayer, cx: number, cy: number): boolean {
    const reach = me.range + 2;
    return game.bombs.some(
      (b) => b.ownerId !== this.playerId && Math.abs(b.cx - cx) + Math.abs(b.cy - cy) <= reach,
    );
  }

  /** Can we legally drop a bomb on this tile right now? */
  private canBomb(game: Game, me: GamePlayer, cx: number, cy: number): boolean {
    if (game.bombAt(cx, cy)) return false;
    return game.bombs.filter((b) => b.ownerId === this.playerId).length < me.bombCap;
  }

  /** Would a bomb dropped here this instant catch a living enemy? */
  private blastHitsEnemy(
    game: Game,
    me: GamePlayer,
    cx: number,
    cy: number,
    enemies: GamePlayer[],
  ): boolean {
    const blast = new Set<number>();
    addBlastCells(game, cx, cy, me.range, blast);
    return enemies.some((e) => blast.has(game.idx(Math.floor(e.x), Math.floor(e.y))));
  }

  /** Would a bomb dropped here destroy at least one crate? */
  private blastHitsCrate(game: Game, me: GamePlayer, cx: number, cy: number): boolean {
    for (const { dx, dy } of DIRS) {
      for (let r = 1; r <= me.range; r++) {
        const x = cx + dx * r;
        const y = cy + dy * r;
        if (!game.contains(x, y)) break;
        const tile = game.grid[game.idx(x, y)];
        if (tile === TILE_WALL || tile === TILE_CRUSH) break;
        if (tile === TILE_CRATE) return true;
      }
    }
    return false;
  }

  /**
   * After committing to a bomb on our tile, is there a route to a cell that is
   * safe, outside our own blast, and roomy (has an onward exit so we don't flee
   * into a dead end)? Returns that escape route, or null if bombing would be
   * suicide. We require the destination to keep at least two reachable safe
   * cells so a follow-up threat can't immediately trap us.
   */
  private bombEscape(
    game: Game,
    me: GamePlayer,
    cx: number,
    cy: number,
    now: number,
    safe: (i: number) => boolean,
    inTime: (i: number, depth: number) => boolean,
    margin: number,
    msPerTile: number,
  ): PathResult | null {
    const myBlast = new Set<number>();
    addBlastCells(game, cx, cy, me.range, myBlast);
    const myAt = now + BOMB_FUSE_MS;
    const safeAfterBomb = (i: number): boolean => safe(i) && !myBlast.has(i);
    const enterAfterBomb = (i: number, depth: number): boolean =>
      inTime(i, depth) && (!myBlast.has(i) || myAt > now + depth * msPerTile + margin);
    const roomy = findPath(
      game,
      this.playerId,
      cx,
      cy,
      (i) => {
        if (!safeAfterBomb(i)) return false;
        const gx = i % game.width;
        const gy = Math.floor(i / game.width);
        // Require an onward exit beyond the refuge itself, so a single blocking
        // bomb (ours or a foe's) can't seal us into a pocket.
        return safeAreaSize(game, this.playerId, gx, gy, safeAfterBomb, 3) >= 3;
      },
      enterAfterBomb,
      this.order(),
    );
    if (roomy) return roomy;
    // Fall back to any safe getaway rather than skipping a good bomb because
    // the only refuge is a pocket.
    return findPath(game, this.playerId, cx, cy, safeAfterBomb, enterAfterBomb, this.order());
  }

  /** A cell from which a bomb we place would catch some enemy in a clear line. */
  private isAttackCell(game: Game, me: GamePlayer, idx: number, enemies: GamePlayer[]): boolean {
    const x = idx % game.width;
    const y = Math.floor(idx / game.width);
    for (const enemy of enemies) {
      const ex = Math.floor(enemy.x);
      const ey = Math.floor(enemy.y);
      if (ex !== x && ey !== y) continue;
      const dist = Math.abs(ex - x) + Math.abs(ey - y);
      if (dist === 0 || dist > me.range) continue;
      const dx = Math.sign(ex - x);
      const dy = Math.sign(ey - y);
      let clear = true;
      for (let r = 1; r < dist; r++) {
        const tile = game.grid[game.idx(x + dx * r, y + dy * r)];
        if (tile === TILE_WALL || tile === TILE_CRATE || tile === TILE_CRUSH) {
          clear = false;
          break;
        }
      }
      if (clear) return true;
    }
    return false;
  }

  /** True when no safe route reaches any attack cell on an enemy (we're boxed). */
  private huntPathBlocked(
    game: Game,
    me: GamePlayer,
    cx: number,
    cy: number,
    enemies: GamePlayer[],
    safe: (i: number) => boolean,
  ): boolean {
    const path = findPath(
      game,
      this.playerId,
      cx,
      cy,
      (i) => this.isAttackCell(game, me, i, enemies),
      (i) => safe(i),
      this.order(),
    );
    return path === null;
  }

  /** Inside the central square the sudden-death spiral never fills. */
  private inSafeArea(game: Game, x: number, y: number): boolean {
    const half = (CRUSH_SAFE_SIZE - 1) >> 1;
    const cx = (game.width - 1) >> 1;
    const cy = (game.height - 1) >> 1;
    return Math.abs(x - cx) <= half && Math.abs(y - cy) <= half;
  }

  private adjacentToCrate(game: Game, idx: number): boolean {
    const x = idx % game.width;
    const y = Math.floor(idx / game.width);
    for (const { dx, dy } of DIRS) {
      if (game.contains(x + dx, y + dy) && game.grid[game.idx(x + dx, y + dy)] === TILE_CRATE) {
        return true;
      }
    }
    return false;
  }

  private randomSafeStep(
    game: Game,
    cx: number,
    cy: number,
    safe: (i: number) => boolean,
  ): Direction | null {
    const options = DIRS.filter(
      (d) => walkable(game, this.playerId, cx + d.dx, cy + d.dy) && safe(game.idx(cx + d.dx, cy + d.dy)),
    );
    const pick = options[Math.floor(this.rng() * options.length)];
    return pick ? pick.dir : null;
  }

  /** Drift to the safe neighbour that opens onto the most space (avoid corners). */
  private bestDrift(
    game: Game,
    cx: number,
    cy: number,
    safe: (i: number) => boolean,
  ): Direction | null {
    let best: Direction | null = null;
    let bestArea = -1;
    for (const { dir, dx, dy } of this.order()) {
      const x = cx + dx;
      const y = cy + dy;
      if (!walkable(game, this.playerId, x, y) || !safe(game.idx(x, y))) continue;
      const area = safeAreaSize(game, this.playerId, x, y, safe, 8);
      if (area > bestArea) {
        bestArea = area;
        best = dir;
      }
    }
    return best;
  }
}
