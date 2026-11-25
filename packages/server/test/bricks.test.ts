import { describe, expect, it } from 'vitest';
import {
  BOMB_FUSE_MS,
  ROOM_SIZE_GRID,
  TILE_CRATE,
  generateMap,
  isPillar,
  mulberry32,
  spawnClearedCells,
  type RoomSize,
} from '@blastmates/shared';
import { MAX_BRANDED_TILES, placeBricks, selectBricks, type BrickCandidate } from '../src/bricks';
import { Game } from '../src/game';

// Brick tests run on a 6-player room (15x13), matching the classic arena.
const SIZE: RoomSize = 6;
const W = ROOM_SIZE_GRID[SIZE].width;
const H = ROOM_SIZE_GRID[SIZE].height;
const ti = (x: number, y: number): number => y * W + x;

function candidate(id: string, size: 1 | 2 | 3, appearances = 0): BrickCandidate {
  return {
    id,
    size,
    tileUrls: Array.from({ length: size }, (_, i) => `/uploads/${id}/${i}.png`),
    name: id.toUpperCase(),
    link: `https://example.com/${id}`,
    appearances,
  };
}

describe('brick selection', () => {
  it('never exceeds the 5-tile cap, over many random draws', () => {
    const candidates = [
      candidate('a', 3),
      candidate('b', 2),
      candidate('c', 2),
      candidate('d', 1),
      candidate('e', 3),
      candidate('f', 1),
      candidate('g', 1),
    ];
    for (let seed = 0; seed < 200; seed++) {
      const picked = selectBricks(candidates, mulberry32(seed));
      const tiles = picked.reduce((sum, b) => sum + b.size, 0);
      expect(tiles).toBeLessThanOrEqual(MAX_BRANDED_TILES);
      expect(picked.length).toBeGreaterThan(0);
    }
  });

  it('takes everything when it fits', () => {
    const picked = selectBricks([candidate('a', 2), candidate('b', 3)], mulberry32(1));
    expect(picked).toHaveLength(2);
  });

  it('fairly favours the least-shown bricks so every banner gets rotated in', () => {
    // Eight equal-size bricks but only five tile-slots: a uniform picker would
    // let lucky bricks run away. Track each brick's appearances across many
    // matches and feed them back, the way the live cache does.
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const shown = new Map(ids.map((id) => [id, 0]));
    const rng = mulberry32(7);
    for (let match = 0; match < 400; match++) {
      const pool = ids.map((id) => candidate(id, 1, shown.get(id)!));
      for (const b of selectBricks(pool, rng)) shown.set(b.id, shown.get(b.id)! + 1);
    }
    const counts = [...shown.values()];
    // Every brick must have been shown, and the spread stays tight — the
    // fairness weighting keeps the most- and least-shown within a small band
    // (a uniform shuffle would drift far wider over 400 matches).
    expect(Math.min(...counts)).toBeGreaterThan(0);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThan(40);
  });

  it('lets a brand-new (0-appearance) brick overtake a saturated one', () => {
    // One brick has been shown thousands of times, a newcomer none: the
    // newcomer should win the slot in the vast majority of matches.
    let newcomerWins = 0;
    for (let seed = 0; seed < 200; seed++) {
      const picked = selectBricks(
        [candidate('old', 3, 5000), candidate('new', 3, 0)],
        mulberry32(seed),
      );
      if (picked[0]?.id === 'new') newcomerWins++;
    }
    expect(newcomerWins).toBeGreaterThan(180); // ~heavily biased toward fresh
  });
});

describe('brick placement', () => {
  it('places clusters on pillar-free rows, never on pillars or spawn clearings', () => {
    const cleared = spawnClearedCells(SIZE);
    for (let seed = 0; seed < 100; seed++) {
      const rng = mulberry32(seed);
      const grid = generateMap(SIZE, rng);
      const placed = placeBricks(grid, SIZE, [candidate('a', 3), candidate('b', 2)], rng);
      expect(placed.length).toBe(2);
      const seen = new Set<number>();
      for (const p of placed) {
        expect(p.y % 2).toBe(0); // pillar-free row
        for (let i = 0; i < p.size; i++) {
          const idx = ti(p.x + i, p.y);
          expect(p.x + i).toBeLessThan(W);
          expect(isPillar(p.x + i, p.y)).toBe(false);
          expect(cleared.has(idx)).toBe(false);
          expect(seen.has(idx)).toBe(false); // no overlap between bricks
          seen.add(idx);
          expect(grid[idx]).toBe(TILE_CRATE); // placed cells become crates
        }
      }
    }
  });

  it('keeps the whole grid otherwise intact', () => {
    const rng = mulberry32(5);
    const grid = generateMap(SIZE, rng);
    const before = Uint8Array.from(grid);
    const placed = placeBricks(grid, SIZE, [candidate('a', 1)], rng);
    expect(placed).toHaveLength(1);
    let diff = 0;
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] !== before[i]) diff++;
    }
    expect(diff).toBeLessThanOrEqual(1); // at most the placed cell flipped to crate
  });
});

describe('branded crates in the game', () => {
  function emptyGrid(): Uint8Array {
    return new Uint8Array(W * H);
  }

  it('behaves exactly like a crate: destructible, counts stats, can be fully destroyed', () => {
    const game = new Game(['a'], {
      size: SIZE,
      grid: emptyGrid(),
      rng: () => 0.99, // no powerup interference, deterministic placement spot
      bricks: [candidate('brand', 2)],
    });
    expect(game.placedBricks).toHaveLength(1);
    const placed = game.placedBricks[0]!;

    // Initial stats: appeared, nothing destroyed.
    let stats = game.brickRoundStats().get('brand')!;
    expect(stats).toEqual({ appearances: 1, tilesDestroyed: 0, fullyDestroyed: 0 });

    // Blow up the first tile: place a bomb right next to it.
    const a = game.players.get('a')!;
    a.bombCap = 8;
    a.range = 1;
    a.x = placed.x + 0.5;
    a.y = placed.y + 1.5; // directly below the first brick tile
    expect(game.placeBomb('a', 0)).toBe(true);
    game.update(BOMB_FUSE_MS, 50);
    stats = game.brickRoundStats().get('brand')!;
    expect(stats.tilesDestroyed).toBe(1);
    expect(stats.fullyDestroyed).toBe(0);

    // Blow up the second tile.
    a.alive = true;
    a.x = placed.x + 1.5;
    a.y = placed.y + 1.5;
    expect(game.placeBomb('a', 10_000)).toBe(true);
    game.update(10_000 + BOMB_FUSE_MS, 50);
    stats = game.brickRoundStats().get('brand')!;
    expect(stats.tilesDestroyed).toBe(2);
    expect(stats.fullyDestroyed).toBe(1);
  });

  it('exposes bricks in snapshots', () => {
    const game = new Game(['a'], {
      size: SIZE,
      grid: emptyGrid(),
      rng: () => 0.5,
      bricks: [candidate('brand', 3)],
    });
    const snaps = game.brickSnapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.tiles).toHaveLength(3);
    expect(snaps[0]!.tiles[0]).toContain('/uploads/brand/');
  });
});
