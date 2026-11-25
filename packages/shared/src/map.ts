import {
  CRATE_FILL,
  CRUSH_SAFE_SIZE,
  ROOM_SIZE_GRID,
  type GridDims,
  type RoomSize,
} from './constants';

export const TILE_EMPTY = 0;
export const TILE_WALL = 1;
export const TILE_CRATE = 2;
/** Indestructible sudden-death block; solid and blast-stopping like a wall. */
export const TILE_CRUSH = 3;
export type Tile = typeof TILE_EMPTY | typeof TILE_WALL | typeof TILE_CRATE | typeof TILE_CRUSH;

export interface Cell {
  x: number;
  y: number;
}

export function tileIndex(x: number, y: number, width: number): number {
  return y * width + x;
}

export function inBounds(x: number, y: number, width: number, height: number): boolean {
  return x >= 0 && x < width && y >= 0 && y < height;
}

export function isPillar(x: number, y: number): boolean {
  return x % 2 === 1 && y % 2 === 1;
}

export function gridDims(size: RoomSize): GridDims {
  return ROOM_SIZE_GRID[size];
}

/**
 * Spawn points for a room size, in slot order. Symmetric per size:
 * 4 = the four corners; 6 = corners + left/right edge midpoints;
 * 8 = corners + all four edge midpoints. Midpoints land on even rows or
 * columns of the odd-dimension grid, so no spawn ever sits on a pillar.
 */
export function spawnPoints(size: RoomSize): Cell[] {
  const { width, height } = ROOM_SIZE_GRID[size];
  const mx = (width - 1) >> 1;
  const my = (height - 1) >> 1;
  const points: Cell[] = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: 0, y: height - 1 },
    { x: width - 1, y: height - 1 },
  ];
  if (size >= 6) points.push({ x: 0, y: my }, { x: width - 1, y: my });
  if (size >= 8) points.push({ x: mx, y: 0 }, { x: mx, y: height - 1 });
  return points;
}

/** Cells that must stay crate-free so players can move at round start. */
export function spawnClearedCells(size: RoomSize): Set<number> {
  const { width, height } = ROOM_SIZE_GRID[size];
  const cleared = new Set<number>();
  for (const spawn of spawnPoints(size)) {
    cleared.add(tileIndex(spawn.x, spawn.y, width));
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const x = spawn.x + dx;
      const y = spawn.y + dy;
      if (inBounds(x, y, width, height) && !isPillar(x, y)) cleared.add(tileIndex(x, y, width));
    }
  }
  return cleared;
}

/**
 * Generate a fresh map for a room size: indestructible pillars on odd/odd
 * cells, destructible crates with ~CRATE_FILL probability elsewhere (a
 * density, so every size feels the same), spawn pockets always clear.
 */
export function generateMap(size: RoomSize, rng: () => number = Math.random): Uint8Array {
  const { width, height } = ROOM_SIZE_GRID[size];
  const grid = new Uint8Array(width * height);
  const cleared = spawnClearedCells(size);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = tileIndex(x, y, width);
      if (isPillar(x, y)) {
        grid[i] = TILE_WALL;
      } else if (!cleared.has(i) && rng() < CRATE_FILL) {
        grid[i] = TILE_CRATE;
      }
    }
  }
  return grid;
}

/**
 * Sudden-death crush order: a clockwise spiral over a width x height grid,
 * starting at the top-left corner and winding inward. Cells matching `skip`
 * (static pillars by default) are omitted, as is the central
 * CRUSH_SAFE_SIZE x CRUSH_SAFE_SIZE safe area, which is never filled.
 * Derived purely from dimensions so any map size gets a correct spiral.
 */
export function crushSpiral(
  width: number,
  height: number,
  skip: (x: number, y: number) => boolean = isPillar,
): Cell[] {
  const cx = (width - 1) >> 1;
  const cy = (height - 1) >> 1;
  const half = (CRUSH_SAFE_SIZE - 1) >> 1;
  const inSafeArea = (x: number, y: number): boolean =>
    Math.abs(x - cx) <= half && Math.abs(y - cy) <= half;

  const order: Cell[] = [];
  const push = (x: number, y: number): void => {
    if (!inSafeArea(x, y) && !skip(x, y)) order.push({ x, y });
  };

  let left = 0;
  let top = 0;
  let right = width - 1;
  let bottom = height - 1;
  while (left <= right && top <= bottom) {
    for (let x = left; x <= right; x++) push(x, top);
    for (let y = top + 1; y <= bottom; y++) push(right, y);
    if (top < bottom) for (let x = right - 1; x >= left; x--) push(x, bottom);
    if (left < right) for (let y = bottom - 1; y >= top + 1; y--) push(left, y);
    left++;
    top++;
    right--;
    bottom--;
  }
  return order;
}

const TILE_CHARS = '.#CX';

export function gridToString(grid: Uint8Array): string {
  let out = '';
  for (let i = 0; i < grid.length; i++) out += TILE_CHARS[grid[i] ?? 0];
  return out;
}

export function gridFromString(s: string): Uint8Array {
  const grid = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = TILE_CHARS.indexOf(s[i] ?? '.');
    grid[i] = c >= 0 ? c : TILE_EMPTY;
  }
  return grid;
}
