/**
 * Render active bricks EXACTLY as they appear in a match: each 16x16 tile is a
 * separate crate with its own 1px black frame + light-gray corner nails
 * (see client drawBrandedCrate), the tiles sit adjacent on the dark-green arena
 * floor, and the whole thing is nearest-neighbour upscaled so you can see it.
 *
 *   ./node_modules/.bin/tsx scripts/preview-bricks.ts [scale]
 */
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config';
import { Store } from '../src/store';

const TILE = 16;
const SCALE = Number(process.argv[2] ?? 16);
const MARGIN = 8; // floor border around the brick, in source px

const FLOOR: [number, number, number] = [0, 135, 81]; // palette 3, arena floor
const FLOOR_SPECK: [number, number, number] = [29, 43, 83]; // palette 1
const BLACK: [number, number, number] = [0, 0, 0];
const NAIL: [number, number, number] = [194, 195, 199]; // palette 6

function put(buf: Buffer, w: number, x: number, y: number, c: [number, number, number]): void {
  const i = (y * w + x) * 3;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
}

async function tileRaw(file: string): Promise<Buffer> {
  return sharp(file).removeAlpha().raw().toBuffer();
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(cfg.dbPath);
  const bricks = store.activeBricks(Date.now());
  if (bricks.length === 0) {
    console.log('no active bricks to preview');
    store.close();
    return;
  }

  for (const brick of bricks) {
    const cols = brick.size * TILE;
    const w = cols + MARGIN * 2;
    const h = TILE + MARGIN * 2;
    const out = Buffer.alloc(w * h * 3);

    // Floor background with a few specks, like the real arena.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const speck = (x * 7 + y * 13) % 37 === 0;
        put(out, w, x, y, speck ? FLOOR_SPECK : FLOOR);
      }
    }

    // Each tile: drawn, then framed exactly like drawBrandedCrate.
    for (let t = 0; t < brick.size; t++) {
      const raw = await tileRaw(path.join(cfg.uploadsDir, brick.tilePaths[t]!));
      const ox = MARGIN + t * TILE;
      const oy = MARGIN;
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const si = (y * TILE + x) * 3;
          put(out, w, ox + x, oy + y, [raw[si]!, raw[si + 1]!, raw[si + 2]!]);
        }
      }
      // 1px black frame
      for (let x = 0; x < TILE; x++) {
        put(out, w, ox + x, oy, BLACK);
        put(out, w, ox + x, oy + TILE - 1, BLACK);
      }
      for (let y = 0; y < TILE; y++) {
        put(out, w, ox, oy + y, BLACK);
        put(out, w, ox + TILE - 1, oy + y, BLACK);
      }
      // corner nails
      put(out, w, ox + 1, oy + 1, NAIL);
      put(out, w, ox + TILE - 2, oy + 1, NAIL);
      put(out, w, ox + 1, oy + TILE - 2, NAIL);
      put(out, w, ox + TILE - 2, oy + TILE - 2, NAIL);
    }

    const safe = brick.displayName.replace(/[^a-z0-9]+/gi, '-');
    const file = `/tmp/ingame-${safe}.png`;
    await sharp(out, { raw: { width: w, height: h, channels: 3 } })
      .resize(w * SCALE, h * SCALE, { kernel: 'nearest' })
      .png()
      .toFile(file);
    console.log(`${brick.displayName} -> ${file}`);
  }

  store.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
