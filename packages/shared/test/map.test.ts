import { describe, expect, it } from 'vitest';
import {
  ROOM_SIZES,
  ROOM_SIZE_GRID,
  TILE_CRATE,
  TILE_EMPTY,
  TILE_WALL,
  TILE_CRUSH,
  crushSpiral,
  generateMap,
  gridFromString,
  gridToString,
  isPillar,
  mulberry32,
  spawnClearedCells,
  spawnPoints,
  tileIndex,
  type RoomSize,
} from '../src/index';

describe('room size config', () => {
  it('maps each size to its classic odd-dimension grid', () => {
    expect(ROOM_SIZE_GRID[4]).toEqual({ width: 13, height: 11 });
    expect(ROOM_SIZE_GRID[6]).toEqual({ width: 15, height: 13 });
    expect(ROOM_SIZE_GRID[8]).toEqual({ width: 17, height: 15 });
  });
});

describe.each(ROOM_SIZES.map((s) => [s] as [RoomSize]))('generateMap (%i players)', (size) => {
  const { width, height } = ROOM_SIZE_GRID[size];

  it('places indestructible pillars on odd/odd cells and nowhere else', () => {
    const grid = generateMap(size, mulberry32(1));
    expect(grid).toHaveLength(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const tile = grid[tileIndex(x, y, width)];
        if (isPillar(x, y)) {
          expect(tile).toBe(TILE_WALL);
        } else {
          expect(tile).not.toBe(TILE_WALL);
        }
      }
    }
  });

  it('keeps all spawn pockets (spawn + adjacent walkable cells) crate-free', () => {
    for (let seed = 0; seed < 20; seed++) {
      const grid = generateMap(size, mulberry32(seed));
      for (const i of spawnClearedCells(size)) {
        expect(grid[i]).toBe(TILE_EMPTY);
      }
    }
  });

  it('has symmetric spawn points: corners, then edge midpoints by size', () => {
    const mx = (width - 1) >> 1;
    const my = (height - 1) >> 1;
    const expected = [
      { x: 0, y: 0 },
      { x: width - 1, y: 0 },
      { x: 0, y: height - 1 },
      { x: width - 1, y: height - 1 },
      ...(size >= 6 ? [{ x: 0, y: my }, { x: width - 1, y: my }] : []),
      ...(size >= 8 ? [{ x: mx, y: 0 }, { x: mx, y: height - 1 }] : []),
    ];
    expect(spawnPoints(size)).toEqual(expected);
    expect(spawnPoints(size)).toHaveLength(size);
  });

  it('never traps a spawn: no pillar spawns, two or more cleared escapes each', () => {
    const cleared = spawnClearedCells(size);
    for (const spawn of spawnPoints(size)) {
      expect(isPillar(spawn.x, spawn.y)).toBe(false);
      const escapes = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].filter(([dx, dy]) => cleared.has(tileIndex(spawn.x + dx!, spawn.y + dy!, width)));
      expect(escapes.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('fills roughly 70% of eligible cells with crates (density, not a count)', () => {
    const cleared = spawnClearedCells(size);
    let eligible = 0;
    let crates = 0;
    for (let seed = 0; seed < 50; seed++) {
      const grid = generateMap(size, mulberry32(seed));
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = tileIndex(x, y, width);
          if (isPillar(x, y) || cleared.has(i)) continue;
          eligible++;
          if (grid[i] === TILE_CRATE) crates++;
        }
      }
    }
    const ratio = crates / eligible;
    expect(ratio).toBeGreaterThan(0.65);
    expect(ratio).toBeLessThan(0.75);
  });

  it('is deterministic for a given seed', () => {
    expect(generateMap(size, mulberry32(42))).toEqual(generateMap(size, mulberry32(42)));
  });
});

describe('grid serialization', () => {
  it('round-trips through string encoding', () => {
    const { width, height } = ROOM_SIZE_GRID[8];
    const grid = generateMap(8, mulberry32(7));
    const s = gridToString(grid);
    expect(s).toHaveLength(width * height);
    expect(gridFromString(s)).toEqual(grid);
  });

  it('round-trips crush tiles', () => {
    const grid = generateMap(8, mulberry32(7));
    grid[0] = TILE_CRUSH;
    expect(gridFromString(gridToString(grid))).toEqual(grid);
  });
});

describe('crushSpiral', () => {
  // Spiral logic is generic over map dimensions: verify every configured
  // room size plus a hypothetical smaller variant.
  const sizes: Array<[number, number]> = [
    ...ROOM_SIZES.map((s): [number, number] => [ROOM_SIZE_GRID[s].width, ROOM_SIZE_GRID[s].height]),
    [11, 9],
  ];

  it('covers every non-pillar cell outside the central 3x3 exactly once', () => {
    for (const [w, h] of sizes) {
      const order = crushSpiral(w, h);
      const seen = new Set(order.map((c) => c.y * w + c.x));
      expect(seen.size).toBe(order.length); // no duplicates
      const cx = (w - 1) >> 1;
      const cy = (h - 1) >> 1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const inSafeArea = Math.abs(x - cx) <= 1 && Math.abs(y - cy) <= 1;
          expect(seen.has(y * w + x)).toBe(!inSafeArea && !isPillar(x, y));
        }
      }
    }
  });

  it('starts at the top-left corner and winds clockwise', () => {
    for (const [w, h] of sizes) {
      const order = crushSpiral(w, h);
      expect(order[0]).toEqual({ x: 0, y: 0 });
      expect(order[1]).toEqual({ x: 1, y: 0 });
      expect(order[w - 1]).toEqual({ x: w - 1, y: 0 });
      expect(order[w]).toEqual({ x: w - 1, y: 1 }); // turns down the right edge
    }
  });

  it('winds inward, ending next to the safe area at the center', () => {
    for (const [w, h] of sizes) {
      const order = crushSpiral(w, h);
      const last = order[order.length - 1]!;
      expect(Math.abs(last.x - ((w - 1) >> 1))).toBeLessThanOrEqual(2);
      expect(Math.abs(last.y - ((h - 1) >> 1))).toBeLessThanOrEqual(2);
    }
  });
});
