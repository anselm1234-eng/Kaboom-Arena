/**
 * Headless visual verification: screenshots demo scenes with Chrome and
 * checks canvas-only scenes for PICO-8 palette purity (no AA, no blur).
 *
 * Usage: node scripts/shots.mjs [sceneFilter]
 * Requires the vite dev server (starts one if :5173 is not responding).
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = '/tmp/blastmates-shots';
const BASE = 'http://localhost:5173';

// PICO-8 palette (must match src/palette.ts)
const PALETTE = [
  '#000000', '#1D2B53', '#7E2553', '#008751', '#AB5236', '#5F574F', '#C2C3C7', '#FFF1E8',
  '#FF004D', '#FFA300', '#FFEC27', '#00E436', '#29ADFF', '#83769C', '#FF77A8', '#FFCCAA',
];
const PALETTE_SET = new Set(
  PALETTE.map((h) => (parseInt(h.slice(1), 16) >>> 0)),
);

const SCENES = [
  { name: 'landing', url: '/', bare: false, budget: 2500 },
  { name: 'lobby', url: '/?demo=lobby', bare: false, budget: 2500 },
  { name: 'lobby-guest', url: '/?demo=lobby&guest=1', bare: false, budget: 2500 },
  { name: 'start', url: '/?demo=start&bare=1', bare: true, budget: 3000 },
  { name: 'game', url: '/?demo=game&bare=1', bare: true, budget: 4000 },
  { name: 'explosion', url: '/?demo=explosion&bare=1', bare: true, budget: 3850 },
  { name: 'win', url: '/?demo=win&bare=1', bare: true, budget: 3000 },
  { name: 'page-bricks', url: '/bricks', bare: false, budget: 2500 },
  { name: 'page-wall', url: '/wall', bare: false, budget: 2500 },
  { name: 'page-tos', url: '/tos', bare: false, budget: 2500 },
];

const GAME_SERVER_PORT = 8080;
const SHOTS_DATA = '/tmp/blastmates-shots-data';
const SHOTS_SECRET = 'shots-secret';
// 48x16 blue/yellow PNG used to seed a demo brick for /wall.
const SEED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAADAAAAAQCAYAAABQrvyxAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAARklEQVR4nO2UwQ0AMAgC3cYwPJu5Ax3CNNaGB38OkQClzYppAzAAP6uQKp8WDFC+gFwh+onTK6RbM4plimkDMADnU+xU6ADqOMi5ymdoFAAAAABJRU5ErkJggg==',
  'base64',
);

async function gameServerUp() {
  try {
    const res = await fetch(`http://localhost:${GAME_SERVER_PORT}/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}

/** Create + activate one brick so /wall has content. */
async function seedBrick() {
  const base = `http://localhost:${GAME_SERVER_PORT}`;
  const src = await (
    await fetch(`${base}/api/bricks/source`, { method: 'POST', body: SEED_PNG })
  ).json();
  const rendered = await (
    await fetch(`${base}/api/bricks/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: src.uploadId, source: 0, size: 3 }),
    })
  ).json();
  const created = await (
    await fetch(`${base}/api/bricks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        uploadId: src.uploadId,
        source: 0,
        variant: rendered.variants?.[0]?.key ?? 'fill',
        size: 3,
        displayName: 'PIXEL CO',
        linkUrl: 'https://example.com',
      }),
    })
  ).json();
  const payload = Buffer.from(
    JSON.stringify({
      meta: { event_name: 'order_created', custom_data: { brick_id: created.brickId } },
      data: { id: '1', attributes: {} },
    }),
  );
  const sig = createHmac('sha256', SHOTS_SECRET).update(payload).digest('hex');
  await fetch(`${base}/api/webhooks/lemonsqueezy`, {
    method: 'POST',
    headers: { 'x-signature': sig },
    body: payload,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function devServerUp() {
  try {
    const res = await fetch(BASE + '/');
    return res.ok;
  } catch {
    return false;
  }
}

function shoot(scene) {
  return new Promise((resolve, reject) => {
    const out = path.join(OUT_DIR, `${scene.name}.png`);
    const proc = spawn(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--force-device-scale-factor=1',
      '--hide-scrollbars',
      `--screenshot=${out}`,
      '--window-size=920,1000',
      `--virtual-time-budget=${scene.budget}`,
      `${BASE}${scene.url}`,
    ]);
    proc.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`chrome exit ${code}`))));
    proc.on('error', reject);
  });
}

function checkPalette(file) {
  const png = PNG.sync.read(readFileSync(file));
  const offColors = new Map();
  let off = 0;
  const total = png.width * png.height;
  for (let i = 0; i < png.data.length; i += 4) {
    const key = ((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]) >>> 0;
    if (!PALETTE_SET.has(key)) {
      off++;
      const hex = `#${key.toString(16).padStart(6, '0')}`;
      offColors.set(hex, (offColors.get(hex) ?? 0) + 1);
    }
  }
  const top = [...offColors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return { off, total, top };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const filter = process.argv[2];

  let dev = null;
  if (!(await devServerUp())) {
    console.log('starting vite dev server…');
    dev = spawn('pnpm', ['dev'], { cwd: CLIENT_DIR, stdio: 'ignore', detached: false });
    for (let i = 0; i < 60 && !(await devServerUp()); i++) await sleep(250);
  }

  // The /bricks and /wall pages need the API: run the built game server too.
  let gameServer = null;
  if (!(await gameServerUp())) {
    console.log('starting game server…');
    rmSync(SHOTS_DATA, { recursive: true, force: true });
    gameServer = spawn('node', ['../server/dist/server.cjs'], {
      cwd: CLIENT_DIR,
      env: {
        ...process.env,
        PORT: String(GAME_SERVER_PORT),
        DB_PATH: `${SHOTS_DATA}/db.sqlite`,
        UPLOADS_DIR: `${SHOTS_DATA}/uploads`,
        LEMONSQUEEZY_WEBHOOK_SECRET: SHOTS_SECRET,
      },
      stdio: 'ignore',
    });
    for (let i = 0; i < 40 && !(await gameServerUp()); i++) await sleep(250);
    try {
      await seedBrick();
    } catch (err) {
      console.error('brick seeding failed:', err.message);
    }
  }

  let failed = 0;
  try {
    for (const scene of SCENES) {
      if (filter && scene.name !== filter) continue;
      const file = await shoot(scene);
      if (scene.bare) {
        const { off, total, top } = checkPalette(file);
        const pct = ((off / total) * 100).toFixed(3);
        const ok = off === 0;
        if (!ok) failed++;
        console.log(`${ok ? '✓' : '✗'} ${scene.name}: ${file} — off-palette ${off}/${total} (${pct}%)`);
        if (!ok) for (const [hex, n] of top) console.log(`    ${hex} x${n}`);
      } else {
        console.log(`• ${scene.name}: ${file} (visual check only)`);
      }
    }
  } finally {
    dev?.kill();
    gameServer?.kill();
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
