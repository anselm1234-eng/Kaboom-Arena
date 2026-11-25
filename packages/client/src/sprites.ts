import type { PowerupKind } from '@blastmates/shared';
import { charToIndex, color } from './palette';

/**
 * All sprites are generated at startup as offscreen canvases from 2D arrays
 * of palette indices (null = transparent). Replace `toCanvas` results with
 * PNG spritesheets later without touching the renderer.
 */

export const TILE = 16;

type Grid = (number | null)[][];
type Spr = HTMLCanvasElement;

function makeCanvas(w: number, h: number): { canvas: Spr; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

function toCanvas(grid: Grid): Spr {
  const h = grid.length;
  const w = grid[0]?.length ?? 0;
  const { canvas, ctx } = makeCanvas(w, h);
  for (let y = 0; y < h; y++) {
    const row = grid[y];
    if (!row) continue;
    for (let x = 0; x < w; x++) {
      const idx = row[x];
      if (idx !== null && idx !== undefined) {
        ctx.fillStyle = color(idx);
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
  return canvas;
}

/** Parse rows of chars into a grid. '.'/' ' transparent, hex = palette index, letters via map. */
function grid(rows: string[], map: Record<string, number> = {}): Grid {
  return rows.map((row) => {
    const out: (number | null)[] = [];
    for (const ch of row) {
      if (ch in map) out.push(map[ch] ?? null);
      else out.push(charToIndex(ch));
    }
    return out;
  });
}

function mirrorGrid(g: Grid): Grid {
  return g.map((row) => [...row].reverse());
}

function rotateCW(g: Grid): Grid {
  const h = g.length;
  const w = g[0]?.length ?? 0;
  const out: Grid = [];
  for (let y = 0; y < w; y++) {
    const row: (number | null)[] = [];
    for (let x = 0; x < h; x++) row.push(g[h - 1 - x]?.[y] ?? null);
    out.push(row);
  }
  return out;
}

function filled(w: number, h: number, fill: (x: number, y: number) => number | null): Grid {
  const out: Grid = [];
  for (let y = 0; y < h; y++) {
    const row: (number | null)[] = [];
    for (let x = 0; x < w; x++) row.push(fill(x, y));
    out.push(row);
  }
  return out;
}

// --- World tiles ---

function floorTiles(): [Spr, Spr] {
  const a = filled(TILE, TILE, () => 3);
  const b = filled(TILE, TILE, (x, y) => {
    if ((x === 3 && y === 4) || (x === 11 && y === 9) || (x === 7 && y === 13)) return 1;
    return 3;
  });
  return [toCanvas(a), toCanvas(b)];
}

function pillarTile(): Spr {
  // Clean NES bevel: light top/left, dark bottom/right, inner shading step.
  const g = filled(TILE, TILE, (x, y) => {
    if (y <= 1 && x < 15) return 6;
    if (x === 0) return 6;
    if (y >= 14 || x === 15) return 1;
    if (y === 13 || x === 14) return 1;
    if (y >= 10 && x >= 2 && x <= 13) return 5;
    if (y >= 3 && y <= 9 && x >= 3 && x <= 12) return 6;
    return 5;
  });
  return toCanvas(g);
}

function crushTile(): Spr {
  // Sudden-death slab: dark iron block with a lavender bevel and red rivets,
  // clearly distinct from the gray pillar.
  const g = filled(TILE, TILE, (x, y) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) return 0;
    if (y === 1 || x === 1) return 13;
    if (y >= 13 || x === 14) return 1;
    if ((x === 4 || x === 11) && (y === 4 || y === 11)) return 8;
    if (y >= 3 && y <= 11 && x >= 3 && x <= 12) return 5;
    return 1;
  });
  return toCanvas(g);
}

function borderTile(): Spr {
  // Brick pattern: dark mortar, staggered joints.
  const g = filled(TILE, TILE, (x, y) => {
    if (y % 8 === 0) return 1;
    const joint = y % 16 < 8 ? 8 : 3;
    if (x === joint || x === (joint + 8) % 16) return 1;
    if (y % 8 === 1) return 6; // brick top highlight
    return 5;
  });
  return toCanvas(g);
}

// --- Crate + crumble ---

const CRATE_ROWS = [
  '0000000000000000',
  '0ffffffffffffff0',
  '04f4444444444420',
  '0464444444446420',
  '0444444444444420',
  '0222222222222220',
  '04f4444444444420',
  '0464444444446420',
  '0444444444444420',
  '0444444444444420',
  '0222222222222220',
  '04f4444444444420',
  '0464444444446420',
  '0444444444444420',
  '0222222222222220',
  '0000000000000000',
];

function crateSprites(): { crate: Spr; flash: Spr; crumble: Spr[] } {
  const base = grid(CRATE_ROWS);
  const flash = base.map((row) => row.map((c) => (c === null ? null : 7)));

  const c0 = base.map((row) => [...row]);
  for (const [x, y] of [
    [4, 3], [5, 4], [6, 5], [7, 6], [8, 7], [9, 8], [10, 9], [11, 10],
    [11, 3], [10, 4], [9, 5],
  ] as const) {
    const row = c0[y];
    if (row) row[x] = 0;
  }

  const c1 = c0.map((row) => [...row]);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 5; x++) {
      const row = c1[y];
      if (row && x + y < 5) row[x] = null;
    }
  }
  for (let y = 12; y < 16; y++) {
    for (let x = 11; x < 16; x++) {
      const row = c1[y];
      if (row && x - 11 + (y - 12) > 2) row[x] = null;
    }
  }

  const c2 = grid([
    '................',
    '................',
    '....44..........',
    '....44....22....',
    '................',
    '..2.......44....',
    '................',
    '......44........',
    '................',
    '.44...........4.',
    '.44..22......44.',
    '................',
    '044...44...4..40',
    '0444.4424.444.40',
    '0442444444244440',
    '0000000000000000',
  ]);

  const c3 = grid([
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
    '....4....2......',
    '..............4.',
    '..2....44.......',
    '.4..........2...',
    '...44...2..4....',
    '................',
  ]);

  return { crate: toCanvas(base), flash: toCanvas(flash), crumble: [c0, c1, c2, c3].map(toCanvas) };
}

// --- Bomb ---

function bombSprite(fat: boolean): Spr {
  const r = fat ? 6 : 5.4;
  const cx = 7.5;
  const cy = 9;
  const g = filled(TILE, TILE, (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= r) {
      // shine on the upper-left
      const sx = x - (cx - 2);
      const sy = y - (cy - 3);
      const sd = Math.sqrt(sx * sx + sy * sy);
      if (sd <= 1.2) return 7;
      if (sd <= 2.4) return 6;
      if (d >= r - 1.2 && dx > 0 && dy > 0) return 1; // bottom-right rim, subtle
      return 0;
    }
    return null;
  });
  // fuse
  const fuse: Array<[number, number, number]> = [
    [9, 3, 4],
    [10, 2, 4],
    [10, 1, 9],
  ];
  for (const [x, y, c] of fuse) {
    const row = g[y];
    if (row) row[x] = c;
  }
  return toCanvas(g);
}

// --- Explosion (center / arm / cap, 4 frames each) ---

const EXPL_BANDS: number[][] = [
  [7, 10, 9],
  [7, 10, 9, 8],
  [10, 9, 8, 2],
  [9, 8, 2],
];
const EXPL_RADIUS = [4.5, 8, 7, 4];
const ARM_HALF = [2.5, 6.5, 5.5, 2];

function band(frac: number, bands: number[]): number | null {
  if (frac > 1) return null;
  const i = Math.min(Math.floor(frac * bands.length), bands.length - 1);
  return bands[i] ?? null;
}

function explCenter(frame: number): Grid {
  const radius = EXPL_RADIUS[frame] ?? 8;
  const bands = EXPL_BANDS[frame] ?? [9];
  return filled(TILE, TILE, (x, y) => {
    const d = Math.sqrt((x - 7.5) ** 2 + (y - 7.5) ** 2);
    return band(d / radius, bands);
  });
}

function explArmH(frame: number): Grid {
  const half = ARM_HALF[frame] ?? 6;
  const bands = EXPL_BANDS[frame] ?? [9];
  return filled(TILE, TILE, (_x, y) => {
    const d = Math.abs(y - 7.5);
    return band(d / half, bands);
  });
}

function explCapRight(frame: number): Grid {
  const half = ARM_HALF[frame] ?? 6;
  const bands = EXPL_BANDS[frame] ?? [9];
  return filled(TILE, TILE, (x, y) => {
    // taper to a rounded tip on the right
    const taper = x > 7 ? Math.sqrt(Math.max(0, 1 - ((x - 7) / 8.5) ** 2)) : 1;
    const h = half * taper;
    if (h < 0.5) return null;
    const d = Math.abs(y - 7.5);
    return band(d / h, bands);
  });
}

export interface ExplosionSprites {
  center: Spr[];
  armH: Spr[];
  armV: Spr[];
  capRight: Spr[];
  capLeft: Spr[];
  capDown: Spr[];
  capUp: Spr[];
}

function explosionSprites(): ExplosionSprites {
  const frames = [0, 1, 2, 3];
  const capR = frames.map(explCapRight);
  return {
    center: frames.map((f) => toCanvas(explCenter(f))),
    armH: frames.map((f) => toCanvas(explArmH(f))),
    armV: frames.map((f) => toCanvas(rotateCW(explArmH(f)))),
    capRight: capR.map(toCanvas),
    capLeft: capR.map((g) => toCanvas(mirrorGrid(g))),
    capDown: capR.map((g) => toCanvas(rotateCW(g))),
    capUp: capR.map((g) => toCanvas(rotateCW(rotateCW(rotateCW(g))))),
  };
}

// --- Powerups ---

function powerupBg(alt: boolean): Spr {
  const g = filled(TILE, TILE, (x, y) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) return 0;
    if (x === 1 || y === 1) return alt ? 8 : 14;
    if (x === 14 || y === 14) return 2;
    return alt ? 2 : 8;
  });
  return toCanvas(g);
}

const ICON_BOMB = [
  '......44..',
  '.....4....',
  '...0000...',
  '..000000..',
  '.07600000.',
  '.07000000.',
  '.00000000.',
  '..000000..',
  '...0000...',
  '..........',
];
const ICON_FLAME = [
  '....8.....',
  '...98.....',
  '...99..8..',
  '..a99..9..',
  '..9a99.99.',
  '.9aa7a999.',
  '.9a777a99.',
  '.9a777a9..',
  '..a777a9..',
  '...aaa9...',
];
const ICON_BOOT = [
  '..1cc1....',
  '..1cc1....',
  '...cc1....',
  '...cc1....',
  '...ccc1...',
  '...cccc1..',
  '..ccccccc.',
  '..ccccccc.',
  '.077777770',
  '..00000000',
];

function powerupIcons(): Record<PowerupKind, Spr> {
  return {
    bomb: toCanvas(grid(ICON_BOMB)),
    range: toCanvas(grid(ICON_FLAME)),
    speed: toCanvas(grid(ICON_BOOT)),
  };
}

// --- Shadow ---

function shadowSprite(): Spr {
  const g = filled(12, 4, (x, y) => {
    const dx = (x - 5.5) / 5.8;
    const dy = (y - 1.5) / 2;
    return dx * dx + dy * dy <= 1 ? 1 : null;
  });
  return toCanvas(g);
}

// --- Players ---

export interface PlayerSwap {
  main: number;
  shade: number;
}

/** white / black / red / blue (classic four-player order), then green / yellow / orange / pink. */
export const PLAYER_SWAPS: PlayerSwap[] = [
  { main: 7, shade: 6 },
  { main: 5, shade: 1 },
  { main: 8, shade: 2 },
  { main: 12, shade: 1 },
  { main: 11, shade: 3 },
  { main: 10, shade: 9 },
  { main: 9, shade: 4 },
  { main: 14, shade: 2 },
];

/** Representative UI color per player slot (for nicknames, HUD text). */
export const PLAYER_UI_COLOR = [7, 6, 8, 12, 11, 10, 9, 14];

const DOWN_STAND = [
  '.......88.......',
  '......0MM0......',
  '....00MMMM00....',
  '...0MMMMMMMM0...',
  '..0MMMMMMMMMM0..',
  '..0MffffffffM0..',
  '..0Mf11ff11fM0..',
  '..0Mf11ff11fM0..',
  '..0MffffffffM0..',
  '...0MMffffMM0...',
  '....00MMMM00....',
  '...0SMMMMMMS0...',
  '...0SMMMMMMS0...',
  '....0MSSSSM0....',
  '...0SSS00SSS0...',
  '....000..000....',
];

const DOWN_BLINK = DOWN_STAND.map((row, y) =>
  y === 6 || y === 7 ? row.replace(/1/g, y === 7 ? '1' : 'f') : row,
);

const DOWN_WALK_A = [
  ...DOWN_STAND.slice(0, 13),
  '....0MSSSSM0....',
  '..0SSS0...0SSS0.',
  '...000.....000..',
];

const DOWN_WALK_B = [
  ...DOWN_STAND.slice(0, 13),
  '....0MSSSSM0....',
  '.....0SSSSS0....',
  '......00000.....',
];

const UP_STAND = [
  '.......88.......',
  '......0MM0......',
  '....00MMMM00....',
  '...0MMMMMMMM0...',
  '..0MMMMMMMMMM0..',
  '..0MMSSSSSSMM0..',
  '..0MMS1111SMM0..',
  '..0MMS1111SMM0..',
  '..0MMSSSSSSMM0..',
  '...0MMMMMMMM0...',
  '....00MMMM00....',
  '...0SMMMMMMS0...',
  '...0SMMMMMMS0...',
  '....0MSSSSM0....',
  '...0SSS00SSS0...',
  '....000..000....',
];

const UP_WALK_A = [
  ...UP_STAND.slice(0, 13),
  '....0MSSSSM0....',
  '..0SSS0...0SSS0.',
  '...000.....000..',
];

const UP_WALK_B = [
  ...UP_STAND.slice(0, 13),
  '....0MSSSSM0....',
  '.....0SSSSS0....',
  '......00000.....',
];

const RIGHT_STAND = [
  '.......88.......',
  '......0MM0......',
  '....00MMMM00....',
  '...0MMMMMMMM0...',
  '..0MMMMMMMMMM0..',
  '..0MMMMfffffM0..',
  '..0MMMMf11fff0..',
  '..0MMMMf11fff0..',
  '..0MMMMfffffM0..',
  '...0MMMffffM0...',
  '....00MMMM00....',
  '...0SMMMMMMS0...',
  '...0SMMMMMMS0...',
  '....0MSSSSM0....',
  '.....0SSSS0.....',
  '......0000......',
];

const RIGHT_WALK_A = [
  ...RIGHT_STAND.slice(0, 13),
  '....0MSSSSM0....',
  '...0SSS00SSS0...',
  '....000..000....',
];

const RIGHT_WALK_B = [
  ...RIGHT_STAND.slice(0, 13),
  '....0MSSSSM0....',
  '......0SSSS0....',
  '.......0000.....',
];

const VICTORY_UP = [
  '.......88.......',
  '......0MM0......',
  '0S..00MMMM00..S0',
  '0S.0MMMMMMMM0.S0',
  '0S0MMMMMMMMMM0S0',
  '0S0MffffffffM0S0',
  '0S0Mf11ff11fM0S0',
  '.00Mf11ff11fM00.',
  '..0MffffffffM0..',
  '...0MMffffMM0...',
  '....00MMMM00....',
  '....0MMMMMM0....',
  '....0MMMMMM0....',
  '....0MSSSSM0....',
  '...0SSS00SSS0...',
  '....000..000....',
];

const POP_A = [
  '................',
  '................',
  '................',
  '.......7........',
  '.......7........',
  '......a7a.......',
  '....77a7a77.....',
  '...7aa777aa7....',
  '....77a7a77.....',
  '......a7a.......',
  '.......7........',
  '.......7........',
  '................',
  '................',
  '................',
  '................',
];

const POP_B = [
  '................',
  '...7........7...',
  '....a......a....',
  '................',
  '......9..9......',
  '................',
  '.7a....77....a7.',
  '.......77.......',
  '.7a....77....a7.',
  '................',
  '......9..9......',
  '................',
  '....a......a....',
  '...7........7...',
  '................',
  '................',
];

const GHOST_A = [
  '................',
  '................',
  '.....00000......',
  '....0777770.....',
  '...077777770....',
  '...071771770....',
  '...071771770....',
  '...077777770....',
  '...077717770....',
  '...077777770....',
  '...0707070700...',
  '....0.0.0.0.....',
  '................',
  '................',
  '................',
  '................',
];

const GHOST_B = [
  '................',
  '................',
  '.....00000......',
  '....0777770.....',
  '...077777770....',
  '...017717710....',
  '...017717710....',
  '...077777770....',
  '...077717770....',
  '...077777770....',
  '...00707070.....',
  '.....0.0.0.0....',
  '................',
  '................',
  '................',
  '................',
];

export interface PlayerSprites {
  down: [Spr, Spr];
  up: [Spr, Spr];
  right: [Spr, Spr];
  left: [Spr, Spr];
  stand: Spr;
  blink: Spr;
  standUp: Spr;
  standRight: Spr;
  standLeft: Spr;
  victory: [Spr, Spr];
}

export function buildPlayerSprites(swap: PlayerSwap): PlayerSprites {
  return playerSprites(swap);
}

const HAT_CROWN = [
  '....a..aa..a....',
  '....a.aaaa.a....',
  '....aaaaaaaa....',
  '....a9aaaa9a....',
];
const HAT_TOPHAT = [
  '.....000000.....',
  '.....000000.....',
  '.....088880.....',
  '..000000000000..',
];
const HAT_HALO = [
  '.....aaaaaa.....',
  '....aa....aa....',
  '.....aaaaaa.....',
  '................',
];

const HAT_GRIDS: Record<string, string[]> = {
  crown: HAT_CROWN,
  tophat: HAT_TOPHAT,
  halo: HAT_HALO,
};

export function hatSprite(hatId: string): Spr | null {
  const rows = HAT_GRIDS[hatId];
  return rows ? toCanvas(grid(rows)) : null;
}

/** Stamp a hat over the head area of every frame of a player sprite set. */
export function withHat(base: PlayerSprites, hat: Spr): PlayerSprites {
  const stamp = (spr: Spr): Spr => {
    const { canvas, ctx } = makeCanvas(spr.width, spr.height);
    ctx.drawImage(spr, 0, 0);
    ctx.drawImage(hat, 0, 0);
    return canvas;
  };
  const pair = (p: [Spr, Spr]): [Spr, Spr] => [stamp(p[0]), stamp(p[1])];
  return {
    down: pair(base.down),
    up: pair(base.up),
    right: pair(base.right),
    left: pair(base.left),
    stand: stamp(base.stand),
    blink: stamp(base.blink),
    standUp: stamp(base.standUp),
    standRight: stamp(base.standRight),
    standLeft: stamp(base.standLeft),
    victory: pair(base.victory),
  };
}

function playerSprites(swap: PlayerSwap): PlayerSprites {
  const map = { M: swap.main, S: swap.shade, f: 15 };
  const make = (rows: string[]): Spr => toCanvas(grid(rows, map));
  const makeMirror = (rows: string[]): Spr => toCanvas(mirrorGrid(grid(rows, map)));
  return {
    down: [make(DOWN_WALK_A), make(DOWN_WALK_B)],
    up: [make(UP_WALK_A), make(UP_WALK_B)],
    right: [make(RIGHT_WALK_A), make(RIGHT_WALK_B)],
    left: [makeMirror(RIGHT_WALK_A), makeMirror(RIGHT_WALK_B)],
    stand: make(DOWN_STAND),
    blink: make(DOWN_BLINK),
    standUp: make(UP_STAND),
    standRight: make(RIGHT_STAND),
    standLeft: makeMirror(RIGHT_STAND),
    victory: [make(DOWN_STAND), make(VICTORY_UP)],
  };
}

// --- HUD icons (8x8) ---

const HUD_BOMB = [
  '.....4..',
  '..00.4..',
  '.060000.',
  '.0600000',
  '00000000',
  '00000000',
  '.000000.',
  '..0000..',
];
const HUD_FLAME = [
  '...8....',
  '..98.8..',
  '..a9.9..',
  '.9a979..',
  '.9a7a99.',
  '.a777a9.',
  '.a777a9.',
  '..aaa9..',
];
const HUD_CROWN = [
  '........',
  'a..aa..a',
  'a.aaaa.a',
  'aaaaaaaa',
  'aaaaaaaa',
  '.a9aa9a.',
  '.aaaaaa.',
  '........',
];
const HUD_BOOT = [
  '.77.....',
  '.cc.....',
  '.cc.....',
  '.cc.....',
  '.ccc....',
  '.ccccc..',
  '.cccccc.',
  '07777770',
];

export interface Sprites {
  floor: [Spr, Spr];
  pillar: Spr;
  border: Spr;
  crush: Spr;
  crate: Spr;
  crateFlash: Spr;
  crumble: Spr[];
  bomb: [Spr, Spr];
  expl: ExplosionSprites;
  powerBg: [Spr, Spr];
  powerIcons: Record<PowerupKind, Spr>;
  shadow: Spr;
  players: PlayerSprites[];
  pop: [Spr, Spr];
  ghost: [Spr, Spr];
  hud: { bomb: Spr; range: Spr; speed: Spr; crown: Spr };
}

export function buildSprites(): Sprites {
  const crates = crateSprites();
  return {
    floor: floorTiles(),
    pillar: pillarTile(),
    border: borderTile(),
    crush: crushTile(),
    crate: crates.crate,
    crateFlash: crates.flash,
    crumble: crates.crumble,
    bomb: [bombSprite(false), bombSprite(true)],
    expl: explosionSprites(),
    powerBg: [powerupBg(false), powerupBg(true)],
    powerIcons: powerupIcons(),
    shadow: shadowSprite(),
    players: PLAYER_SWAPS.map(playerSprites),
    pop: [toCanvas(grid(POP_A)), toCanvas(grid(POP_B))],
    ghost: [toCanvas(grid(GHOST_A)), toCanvas(grid(GHOST_B))],
    hud: {
      bomb: toCanvas(grid(HUD_BOMB)),
      range: toCanvas(grid(HUD_FLAME)),
      speed: toCanvas(grid(HUD_BOOT)),
      crown: toCanvas(grid(HUD_CROWN)),
    },
  };
}

/** Render a sprite to a data URL at an integer scale (for DOM <img> use). */
export function spriteDataUrl(spr: Spr, scale = 1): string {
  const { canvas, ctx } = makeCanvas(spr.width * scale, spr.height * scale);
  ctx.drawImage(spr, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL();
}
