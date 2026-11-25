import {
  TILE_CRATE,
  TILE_EMPTY,
  gridDims,
  spawnClearedCells,
  tileIndex,
  type RoomSize,
} from '@blastmates/shared';
import type { BrickEngagement, Store } from './store';
import type { BrickSize } from './store';

/** Hard cap of branded crate tiles per match. */
export const MAX_BRANDED_TILES = 5;

export interface BrickCandidate {
  id: string;
  size: BrickSize;
  tileUrls: string[];
  /** Buyer's brand label and optional link, surfaced in the in-game popup. */
  name: string;
  link: string | null;
  /** Lifetime match appearances; drives the fair-rotation weighting. */
  appearances: number;
}

export interface PlacedBrick {
  id: string;
  x: number;
  y: number;
  size: BrickSize;
  tileUrls: string[];
  name: string;
  link: string | null;
}

/**
 * Fair weighted selection. A single match only fits MAX_BRANDED_TILES worth of
 * branded crates, but every active brick has paid for exposure, so over many
 * matches all of them should be shown a comparable number of times — not just
 * whichever ones keep winning a uniform coin flip.
 *
 * We weight each candidate by 1/(appearances + 1) so the least-shown bricks are
 * the most likely to be picked next, then greedily fill the tile budget in
 * weighted-random priority order. The randomness (Efraimidis–Spirakis sampling:
 * key = rng^(1/weight), largest keys win) keeps the rotation from hardening into
 * a rigid queue, so a brick that is briefly ahead still surfaces occasionally
 * and equal-appearance bricks don't deadlock on a fixed order.
 */
export function selectBricks(
  candidates: BrickCandidate[],
  rng: () => number,
): BrickCandidate[] {
  const ranked = candidates
    .map((c) => {
      const weight = 1 / (c.appearances + 1);
      // rng() in (0,1); a larger weight pulls the key toward 1 → picked sooner.
      const key = Math.pow(rng(), 1 / weight);
      return { c, key };
    })
    .sort((a, b) => b.key - a.key);
  const picked: BrickCandidate[] = [];
  let tiles = 0;
  for (const { c } of ranked) {
    if (tiles + c.size <= MAX_BRANDED_TILES) {
      picked.push(c);
      tiles += c.size;
    }
  }
  return picked;
}

/**
 * In-memory accumulator for client-reported brick engagement (popup views and
 * outbound link clicks). A burst of hovers/taps coalesces into per-brick counts
 * that the server flushes to the store in one batched transaction, rather than
 * issuing a DB write per event.
 */
export class BrickEngagementBuffer {
  private pending = new Map<string, BrickEngagement>();

  record(id: string, kind: 'view' | 'click'): void {
    const e = this.pending.get(id) ?? { views: 0, clicks: 0 };
    if (kind === 'view') e.views += 1;
    else e.clicks += 1;
    this.pending.set(id, e);
  }

  /** Hand off the accumulated counts and reset; empty when nothing is pending. */
  flush(): Map<string, BrickEngagement> {
    const out = this.pending;
    this.pending = new Map();
    return out;
  }
}

/**
 * Place brick clusters horizontally on pillar-free rows (even rows in the
 * classic odd/odd pillar layout), never touching the spawn-corner
 * clearings and never overlapping each other. Placed cells become normal
 * crates in the grid — identical gameplay, only the skin differs.
 * Bricks that do not fit are skipped.
 */
export function placeBricks(
  grid: Uint8Array,
  size: RoomSize,
  bricks: BrickCandidate[],
  rng: () => number,
): PlacedBrick[] {
  const { width, height } = gridDims(size);
  const cleared = spawnClearedCells(size);
  const taken = new Set<number>();
  const placed: PlacedBrick[] = [];

  for (const brick of bricks) {
    const spots: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < height; y += 2) {
      // pillar-free rows only
      for (let x = 0; x + brick.size <= width; x++) {
        let ok = true;
        for (let i = 0; i < brick.size; i++) {
          const idx = tileIndex(x + i, y, width);
          const tile = grid[idx];
          if (
            cleared.has(idx) ||
            taken.has(idx) ||
            (tile !== TILE_EMPTY && tile !== TILE_CRATE)
          ) {
            ok = false;
            break;
          }
        }
        if (ok) spots.push({ x, y });
      }
    }
    if (spots.length === 0) continue;
    const spot = spots[Math.floor(rng() * spots.length)];
    if (!spot) continue;
    for (let i = 0; i < brick.size; i++) {
      const idx = tileIndex(spot.x + i, spot.y, width);
      grid[idx] = TILE_CRATE;
      taken.add(idx);
    }
    placed.push({
      id: brick.id,
      x: spot.x,
      y: spot.y,
      size: brick.size,
      tileUrls: brick.tileUrls,
      name: brick.name,
      link: brick.link,
    });
  }
  return placed;
}

/** Cached view of active bricks for match generation; refreshes every 60s. */
export class BrickCache {
  private cached: BrickCandidate[] = [];
  private fetchedAt = 0;

  constructor(
    private readonly store: Store,
    private readonly ttlMs = 60_000,
  ) {}

  candidates(now: number): BrickCandidate[] {
    if (now - this.fetchedAt >= this.ttlMs) {
      this.cached = this.store.activeBricks(now).map((b) => ({
        id: b.id,
        size: b.size,
        tileUrls: b.tilePaths.map((p) => `/uploads/${p}`),
        name: b.displayName,
        link: b.linkUrl,
        appearances: b.appearances,
      }));
      this.fetchedAt = now;
    }
    return this.cached;
  }

  invalidate(): void {
    this.fetchedAt = 0;
  }
}
