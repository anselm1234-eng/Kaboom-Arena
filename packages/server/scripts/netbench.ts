/**
 * Netcode benchmark: measures snapshot size and per-tick CPU cost for a
 * worst-case room (8 players, 17x15 grid) under active play, then
 * extrapolates rooms-per-core at 20Hz and 60Hz.
 *
 * Run: pnpm --filter @blastmates/server exec tsx scripts/netbench.ts
 */
import { generateMap, gridToString, type Direction } from '@blastmates/shared';
import { Game } from '../src/game';
import { performance } from 'node:perf_hooks';
import { deflateRawSync } from 'node:zlib';

// Mirror the server's perMessageDeflate tuning (server.ts) so the compression
// numbers below reflect what actually goes over the wire.
const DEFLATE_OPTS = { level: 3, memLevel: 7 } as const;
const deflated = (json: string): number => deflateRawSync(json, DEFLATE_OPTS).length;

const SIZE = 8 as const;
const PLAYERS = 8;
const TICK_MS = 50;
const ids = Array.from({ length: PLAYERS }, (_, i) => `p${i}`);

// Deterministic rng so runs are comparable.
let seed = 42;
const rng = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

function makeGame(): Game {
  return new Game(ids, { size: SIZE, grid: generateMap(SIZE, rng), rng });
}

const DIRS: (Direction | null)[] = ['up', 'down', 'left', 'right', null];

function snapshotMessage(game: Game, now: number, tick: number) {
  return {
    t: 'snapshot',
    tick,
    serverTime: now,
    grid: gridToString(game.grid),
    players: game.playerSnapshots(),
    bombs: game.bombSnapshots(),
    explosions: game.explosionSnapshots(),
    powerups: game.powerupSnapshots(),
    bricks: game.brickSnapshots(),
    ...(game.suddenDeathAt !== null ? { suddenDeathAt: game.suddenDeathAt } : {}),
    crush: game.crushWarnings(now),
  };
}

// --- 1. Snapshot size over a simulated active match ---
{
  const game = makeGame();
  let maxBytes = 0;
  let sumBytes = 0;
  let sumDeflated = 0;
  let n = 0;
  let firstBytes = 0;
  for (let tick = 1; tick <= 1200; tick++) {
    // 60s of play
    const now = tick * TICK_MS;
    // Chaotic play: every player changes direction sometimes, drops bombs often.
    for (const id of ids) {
      if (rng() < 0.1) game.setInput(id, DIRS[Math.floor(rng() * DIRS.length)] ?? null);
      if (rng() < 0.05) game.placeBomb(id, now);
    }
    game.update(now, TICK_MS);
    const json = JSON.stringify(snapshotMessage(game, now, tick));
    const bytes = Buffer.byteLength(json);
    if (tick === 1) firstBytes = bytes;
    maxBytes = Math.max(maxBytes, bytes);
    sumBytes += bytes;
    sumDeflated += deflated(json);
    n++;
  }
  console.log(`snapshot bytes: first=${firstBytes} avg=${Math.round(sumBytes / n)} max=${maxBytes}`);
  console.log(`snapshot bytes deflated (lvl3): avg ${Math.round(sumDeflated / n)}`);
  console.log(
    `per-client bandwidth @20Hz: avg ${((sumBytes / n) * 20 * 8 / 1000).toFixed(0)} kbit/s raw, ` +
      `${((sumDeflated / n) * 20 * 8 / 1000).toFixed(0)} kbit/s on the wire`,
  );
  console.log(
    `per-room egress (8 clients) @20Hz: avg ${((sumDeflated / n) * 20 * 8 / 1e6).toFixed(2)} Mbit/s on the wire`,
  );
}

// --- 1b. Compression CPU: per-socket (current) vs shared-once-per-room ---
{
  const game = makeGame();
  // Build a representative mid-match snapshot to compress repeatedly.
  for (let tick = 1; tick <= 200; tick++) {
    const now = tick * TICK_MS;
    for (const id of ids) {
      if (rng() < 0.1) game.setInput(id, DIRS[Math.floor(rng() * DIRS.length)] ?? null);
      if (rng() < 0.05) game.placeBomb(id, now);
    }
    game.update(now, TICK_MS);
  }
  const json = JSON.stringify(snapshotMessage(game, 200 * TICK_MS, 200));
  const ITERS = 5000;
  deflated(json); // warmup
  const t0 = performance.now();
  for (let i = 0; i < ITERS; i++) deflated(json);
  const perDeflate = ((performance.now() - t0) / ITERS) * 1000; // µs
  console.log(`\ndeflate cost: ${perDeflate.toFixed(1)} µs per call`);
  console.log(
    `  per-socket (8 clients): ${(perDeflate * 8).toFixed(1)} µs/room-tick  <- current (ws compresses per socket)`,
  );
  console.log(
    `  shared once/room:       ${perDeflate.toFixed(1)} µs/room-tick  <- with uWS publish / pre-deflated frame`,
  );
  console.log(
    `  rooms/core @20Hz (deflate only): per-socket ~${Math.floor(50_000 / (perDeflate * 8))}, shared ~${Math.floor(50_000 / perDeflate)}`,
  );
}

// --- 2. CPU per tick: update + snapshot build + stringify ---
function benchTicks(stringifyPerConn: number): number {
  const game = makeGame();
  const TICKS = 4000;
  const t0 = performance.now();
  for (let tick = 1; tick <= TICKS; tick++) {
    const now = tick * TICK_MS;
    for (const id of ids) {
      if (rng() < 0.1) game.setInput(id, DIRS[Math.floor(rng() * DIRS.length)] ?? null);
      if (rng() < 0.05) game.placeBomb(id, now);
    }
    game.update(now, TICK_MS);
    const msg = snapshotMessage(game, now, tick);
    for (let c = 0; c < stringifyPerConn; c++) JSON.stringify(msg);
  }
  return (performance.now() - t0) / TICKS;
}

benchTicks(1); // warmup
const perTickShared = benchTicks(1); // stringify once per room
const perTickPerConn = benchTicks(8); // current behavior: stringify per connection

console.log(`\nCPU per room-tick (8 players, active):`);
console.log(`  stringify once/room:  ${(perTickShared * 1000).toFixed(1)} µs`);
console.log(`  stringify per conn(8): ${(perTickPerConn * 1000).toFixed(1)} µs  <- current code`);

for (const [label, perTick] of [
  ['current (per-conn stringify)', perTickPerConn],
  ['shared stringify', perTickShared],
] as const) {
  const budget20 = 50 / perTick; // rooms fitting in one 50ms tick on one core
  const budget60 = 16.67 / perTick;
  console.log(
    `${label}: ~${Math.floor(budget20)} rooms/core @20Hz, ~${Math.floor(budget60)} rooms/core @60Hz (100% core)`,
  );
}

// --- 3. CPU with bots: 8 bot-driven players (worst case for public rooms) ---
import { BotController } from '../src/bot';
{
  const game = makeGame();
  const bots = ids.map((id) => new BotController(id, 'normal', rng));
  const TICKS = 4000;
  const t0 = performance.now();
  for (let tick = 1; tick <= TICKS; tick++) {
    const now = tick * TICK_MS;
    for (const bot of bots) {
      const d = bot.update(game, now);
      game.setInput((bot as any).playerId ?? '', d.dir);
      if (d.bomb) game.placeBomb((bot as any).playerId ?? '', now);
    }
    game.update(now, TICK_MS);
    const msg = snapshotMessage(game, now, tick);
    for (let c = 0; c < 8; c++) JSON.stringify(msg);
  }
  const perTick = (performance.now() - t0) / TICKS;
  console.log(`\n8-bot room per-tick: ${(perTick * 1000).toFixed(1)} µs -> ~${Math.floor(50 / perTick)} rooms/core @20Hz`);
}

// --- 4. Branded public room: bricks every tick (old) vs keyframe-only (new) ---
// Public matches always carry branded crate clusters, whose tile URLs + labels
// are constant for the whole round. Section 1 uses no bricks, so it misses this
// per-tick cost entirely; here we quantify what moving bricks to keyframes saves.
{
  const brickCandidates = [
    {
      id: 'acme-co',
      size: 3 as const,
      tileUrls: ['/uploads/3f9a2c1b8e.png', '/uploads/7d4e0a92f1.png', '/uploads/c5b16730ad.png'],
      name: 'ACME Corporation',
      link: 'https://acme.example.com/promo',
      appearances: 0,
    },
    {
      id: 'globex',
      size: 2 as const,
      tileUrls: ['/uploads/a18bf4d220.png', '/uploads/e90c5571bb.png'],
      name: 'Globex',
      link: 'https://globex.example.com',
      appearances: 0,
    },
  ];
  const game = new Game(ids, { size: SIZE, grid: generateMap(SIZE, rng), rng, bricks: brickCandidates });
  let rawWith = 0;
  let defWith = 0;
  let rawWithout = 0;
  let defWithout = 0;
  let n = 0;
  for (let tick = 1; tick <= 1200; tick++) {
    const now = tick * TICK_MS;
    for (const id of ids) {
      if (rng() < 0.1) game.setInput(id, DIRS[Math.floor(rng() * DIRS.length)] ?? null);
      if (rng() < 0.05) game.placeBomb(id, now);
    }
    game.update(now, TICK_MS);
    const withBricks = snapshotMessage(game, now, tick); // includes bricks: [...]
    const { bricks, ...withoutBricks } = withBricks; // keyframe-omitted shape
    const jw = JSON.stringify(withBricks);
    const jo = JSON.stringify(withoutBricks);
    rawWith += Buffer.byteLength(jw);
    defWith += deflated(jw);
    rawWithout += Buffer.byteLength(jo);
    defWithout += deflated(jo);
    n++;
  }
  const brickJson = JSON.stringify(game.brickSnapshots());
  console.log(`\nbranded public room (${brickCandidates.length} bricks, ${brickJson.length}-byte payload):`);
  console.log(`  bricks every tick (old): raw ${Math.round(rawWith / n)}, deflated ${Math.round(defWith / n)}`);
  console.log(`  bricks keyframe-only (new): raw ${Math.round(rawWithout / n)}, deflated ${Math.round(defWithout / n)}`);
  console.log(
    `  per-tick saving: raw ${Math.round((rawWith - rawWithout) / n)} B, ` +
      `deflated ${Math.round((defWith - defWithout) / n)} B ` +
      `(${(100 * (defWith - defWithout) / defWith).toFixed(0)}% on the wire)`,
  );
}
