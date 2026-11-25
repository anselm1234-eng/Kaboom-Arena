/**
 * End-to-end smoke test against the real built server.
 * Run: node scripts/smoke.mjs  (after `pnpm build`)
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import sharp from 'sharp';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SMOKE_DATA = '/tmp/blastmates-smoke';
const WEBHOOK_SECRET = 'smoke-secret';
const ADMIN_TOKEN = 'smoke-admin';

const PORT = 8090;
const URL = `ws://localhost:${PORT}`;
/** Shortened anti-stall timer so the timer-forced start is testable quickly. */
const READY_TIMEOUT_SMOKE_MS = 2000;
let failures = 0;

function ok(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

class Client {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.ws = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => this.msgs.push(JSON.parse(String(data))));
    });
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  close() {
    this.ws?.close();
  }
  /** Wait for a message matching pred (also checks already-received ones). */
  waitFor(pred, timeoutMs = 15000, label = 'message') {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        const found = this.msgs.find(pred);
        if (found) return resolve(found);
        if (Date.now() - start > timeoutMs) {
          return reject(new Error(`${this.name}: timeout waiting for ${label}`));
        }
        setTimeout(check, 50);
      };
      check();
    });
  }
  lastSnapshot() {
    return [...this.msgs].reverse().find((m) => m.t === 'snapshot');
  }
  clearMsgs() {
    this.msgs = [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error('server did not start');
}

async function testQuickMatch() {
  console.log('quick match + full round:');
  const alice = new Client('alice');
  const bob = new Client('bob');
  await alice.connect();
  await bob.connect();

  alice.send({ t: 'join', nickname: 'alice', mode: { kind: 'quick' } });
  const aJoined = await alice.waitFor((m) => m.t === 'joined', 3000, 'joined');
  bob.send({ t: 'join', nickname: 'bob', mode: { kind: 'quick' } });
  const bJoined = await bob.waitFor((m) => m.t === 'joined', 3000, 'joined');
  ok(aJoined.roomId === bJoined.roomId, 'both quick-match players land in the same room');
  ok(aJoined.isPrivate === false, 'quick-match room is public');

  // Hostless ready-check start: nobody is host, the room waits for readies.
  const lobby = await bob.waitFor(
    (m) => m.t === 'room' && m.players.length === 2,
    3000,
    'room roster',
  );
  ok(lobby.hostId === null, 'public room is hostless');
  ok(lobby.readyTimerEndsAt === null, 'anti-stall timer starts disarmed');
  await sleep(600);
  const stillLobby = [...bob.msgs].reverse().find((m) => m.t === 'room');
  ok(stillLobby.state === 'lobby', 'room waits for ready-ups instead of counting down');

  bob.send({ t: 'start' });
  await bob.waitFor((m) => m.t === 'error' && m.code === 'not_allowed', 3000, 'not_allowed');
  ok(true, 'manual start is rejected in public rooms');

  alice.send({ t: 'ready', ready: true });
  const armed = await bob.waitFor(
    (m) => m.t === 'room' && m.readyTimerEndsAt !== null,
    3000,
    'armed timer',
  );
  ok(
    armed.players.find((p) => p.id === aJoined.playerId).ready === true,
    'ready state is broadcast to everyone',
  );
  ok(armed.state === 'lobby', 'one of two ready: still waiting');

  bob.send({ t: 'ready', ready: true });
  await bob.waitFor((m) => m.t === 'room' && m.state === 'countdown', 3000, 'countdown');
  await alice.waitFor((m) => m.t === 'room' && m.state === 'playing', 5000, 'playing');
  console.log('  … round started by ready check');
  const firstSnap = await alice.waitFor((m) => m.t === 'snapshot', 2000, 'snapshot');
  ok(firstSnap.players.length === 2, 'snapshot contains both players');
  ok(firstSnap.grid.length === 195, 'snapshot grid is 15x13');
  const aliceStart = firstSnap.players.find((p) => p.id === aJoined.playerId);
  ok(aliceStart.x === 0.5 && aliceStart.y === 0.5, 'alice spawns at the first corner');
  const bobStart = firstSnap.players.find((p) => p.id === bJoined.playerId);
  ok(bobStart.x === 14.5 && bobStart.y === 0.5, 'bob spawns at the second corner');

  // Movement: alice runs down (her escape lane is open by map rules).
  alice.send({ t: 'input', dir: 'down' });
  await sleep(400);
  alice.send({ t: 'input', dir: null });
  await sleep(200);
  const moved = alice.lastSnapshot().players.find((p) => p.id === aJoined.playerId);
  ok(moved.y > 0.6, `alice moved (y=${moved.y.toFixed(2)})`);

  // Bob drops a bomb and stays on it: he should die when it pops.
  bob.send({ t: 'bomb' });
  await sleep(200);
  ok(bob.lastSnapshot().bombs.length === 1, 'bomb appears in snapshots');
  const boom = await bob.waitFor(
    (m) => m.t === 'snapshot' && m.explosions.length > 0,
    4000,
    'explosion',
  );
  ok(boom.explosions[0].cells.length >= 3, 'explosion covers a cross of cells');

  const end = await alice.waitFor((m) => m.t === 'room' && m.state === 'roundEnd', 3000, 'roundEnd');
  ok(end.winnerId === aJoined.playerId, 'alice wins the round');
  ok(end.players.find((p) => p.id === aJoined.playerId).wins === 1, 'win is tallied');

  // Mid-round joiner becomes a spectator (joins during the round-end pause).
  const carol = new Client('carol');
  await carol.connect();
  carol.send({ t: 'join', nickname: 'carol', mode: { kind: 'quick' } });
  const cJoined = await carol.waitFor((m) => m.t === 'joined', 3000, 'joined');
  ok(cJoined.roomId === aJoined.roomId, 'matchmaking backfills the existing public room');
  ok(cJoined.spectator === true, 'mid-round joiner is a spectator');

  // Public rooms reassemble in the lobby with ready states reset.
  const back = await alice.waitFor(
    (m) => m.t === 'room' && m.state === 'lobby' && m.serverTime > end.serverTime,
    10_000,
    'lobby reassembly',
  );
  ok(
    back.players.filter((p) => !p.bot).every((p) => p.ready === false),
    'ready states reset after the match',
  );
  ok(back.readyTimerEndsAt === null, 'anti-stall timer disarms after the match');

  // Leave cleanly so the room is destroyed and later sections start fresh.
  for (const c of [alice, bob, carol]) {
    c.send({ t: 'leave' });
    c.close();
  }
}

async function testReadyTimerAndBots() {
  console.log('anti-stall timer, bot fill and shared bot controls:');
  const clients = [];
  const joined = [];
  for (const name of ['p1', 'p2', 'p3']) {
    const c = new Client(name);
    await c.connect();
    c.send({ t: 'join', nickname: name, mode: { kind: 'quick' } });
    joined.push(await c.waitFor((m) => m.t === 'joined', 3000, 'joined'));
    clients.push(c);
  }
  const [p1, p2] = clients;

  // Any player (not just the first joiner) can manage bots, rate-limited.
  p2.send({ t: 'addBot' });
  const withBot = await p1.waitFor(
    (m) => m.t === 'room' && m.players.some((p) => p.bot),
    3000,
    'bot added',
  );
  const botId = withBot.players.find((p) => p.bot).id;
  ok(true, 'any player can add a bot in a public room');
  p2.send({ t: 'addBot' });
  await p2.waitFor((m) => m.t === 'error' && m.code === 'rate_limited', 3000, 'rate_limited');
  ok(true, 'bot actions are rate-limited per player');
  await sleep(2100);
  p2.send({ t: 'removeBot', botId });
  await p1.waitFor(
    (m) => m.t === 'room' && !m.players.some((p) => p.bot),
    3000,
    'bot removed',
  );
  ok(true, 'any player can remove a bot after the cooldown');

  // One ready player arms the (shortened) anti-stall timer; expiry launches
  // the match with bots filled in, while the un-ready stay in the lobby.
  p1.send({ t: 'ready', ready: true });
  const armed = await p1.waitFor(
    (m) => m.t === 'room' && m.readyTimerEndsAt !== null,
    3000,
    'armed timer',
  );
  ok(
    armed.readyTimerEndsAt - armed.serverTime <= READY_TIMEOUT_SMOKE_MS + 100,
    'first ready-up arms the anti-stall timer',
  );
  const playing = await p1.waitFor(
    (m) => m.t === 'room' && m.state === 'playing',
    READY_TIMEOUT_SMOKE_MS + 8000,
    'timer-forced start',
  );
  ok(true, 'timer expiry starts the match');
  const fighters = playing.players.filter((p) => !p.spectator);
  ok(fighters.some((p) => p.bot), 'bots fill the thin match');
  ok(
    fighters.filter((p) => !p.bot).length === 1 &&
      fighters.find((p) => p.id === joined[0].playerId),
    'only the ready player fights',
  );
  const benched = playing.players.filter((p) => p.spectator).map((p) => p.id);
  ok(
    benched.includes(joined[1].playerId) && benched.includes(joined[2].playerId),
    'un-ready players stay in the room as spectators, un-kicked',
  );

  for (const c of clients) {
    c.send({ t: 'leave' });
    c.close();
  }
}

async function testPrivateLobby() {
  console.log('private lobby:');
  const host = new Client('host');
  const guest = new Client('guest');
  await host.connect();
  await guest.connect();

  host.send({ t: 'join', nickname: 'host', mode: { kind: 'create', password: 'sekret' } });
  const hJoined = await host.waitFor((m) => m.t === 'joined', 3000, 'joined');
  ok(hJoined.isPrivate === true, 'created room is private');

  // Quick-match must never route into the private room.
  const rando = new Client('rando');
  await rando.connect();
  rando.send({ t: 'join', nickname: 'rando', mode: { kind: 'quick' } });
  const rJoined = await rando.waitFor((m) => m.t === 'joined', 3000, 'joined');
  ok(rJoined.roomId !== hJoined.roomId, 'quick match avoids private rooms');
  rando.send({ t: 'leave' });
  rando.close();

  guest.send({ t: 'join', nickname: 'guest', mode: { kind: 'join', roomId: hJoined.roomId, password: 'wrong' } });
  await guest.waitFor((m) => m.t === 'error' && m.code === 'bad_password', 3000, 'bad_password');
  ok(true, 'wrong password rejected');

  guest.send({ t: 'join', nickname: 'guest', mode: { kind: 'join', roomId: hJoined.roomId, password: 'sekret' } });
  await guest.waitFor((m) => m.t === 'joined', 3000, 'joined');
  ok(true, 'correct password accepted');

  // No auto-start for private rooms; guest cannot start; host can.
  await sleep(600);
  const lastRoom = [...host.msgs].reverse().find((m) => m.t === 'room');
  ok(lastRoom.state === 'lobby', 'private room does not auto-start');
  guest.send({ t: 'start' });
  await guest.waitFor((m) => m.t === 'error' && m.code === 'not_host', 3000, 'not_host');
  ok(true, 'non-host cannot start');
  host.send({ t: 'start' });
  await host.waitFor((m) => m.t === 'room' && m.state === 'playing', 3000, 'playing');
  ok(true, 'host start launches the game');

  // Host disconnects: host migrates to guest.
  host.close();
  const migrated = await guest.waitFor(
    (m) => m.t === 'room' && m.hostId && m.hostId !== hJoined.playerId,
    3000,
    'host migration',
  );
  ok(migrated.hostId !== null, 'host migrated to remaining player');
  guest.close();
}

async function testBrickFlow() {
  console.log('brick purchase flow (simulated Lemon Squeezy):');
  const base = `http://localhost:${PORT}`;

  // 1. Upload a 3x1 image and get the exact pixelated preview.
  const image = await sharp({
    create: { width: 300, height: 100, channels: 3, background: '#ff0000' },
  })
    .png()
    .toBuffer();
  const previewRes = await fetch(`${base}/api/bricks/preview?size=3`, {
    method: 'POST',
    body: image,
  });
  const preview = await previewRes.json();
  ok(previewRes.ok && preview.tileUrls.length === 3, 'preview returns 3 quantized tiles');
  const tileRes = await fetch(`${base}${preview.tileUrls[0]}`);
  ok(tileRes.ok && tileRes.headers.get('content-type') === 'image/png', 'tiles served statically');

  // Garbage upload is rejected by sniffing.
  const badRes = await fetch(`${base}/api/bricks/preview?size=1`, {
    method: 'POST',
    body: Buffer.from('GIF89a fake image'),
  });
  ok(badRes.status === 400, 'non-PNG/JPEG uploads are rejected');

  // 2. Confirm: creates a pending_payment brick (no LS configured -> no checkout URL).
  const createRes = await fetch(`${base}/api/bricks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      uploadId: preview.uploadId,
      size: 3,
      displayName: 'SMOKE INC',
      linkUrl: 'https://example.com',
    }),
  });
  const created = await createRes.json();
  ok(createRes.ok && created.brickId, 'brick created as pending_payment');

  // 3. Payment webhook (HMAC signed) activates the brick.
  const payload = Buffer.from(
    JSON.stringify({
      meta: { event_name: 'order_created', custom_data: { brick_id: created.brickId } },
      data: { id: '424242', attributes: {} },
    }),
  );
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');

  const badSig = await fetch(`${base}/api/webhooks/lemonsqueezy`, {
    method: 'POST',
    headers: { 'x-signature': 'deadbeef' },
    body: payload,
  });
  ok(badSig.status === 401, 'webhook with bad signature rejected (401)');

  const hook = await fetch(`${base}/api/webhooks/lemonsqueezy`, {
    method: 'POST',
    headers: { 'x-signature': sig },
    body: payload,
  });
  ok(hook.status === 200 && (await hook.text()) === 'brick activated', 'signed webhook activates brick');

  const replay = await fetch(`${base}/api/webhooks/lemonsqueezy`, {
    method: 'POST',
    headers: { 'x-signature': sig },
    body: payload,
  });
  ok((await replay.text()) === 'already processed', 'webhook replay is idempotent');

  // 4. Brick is publicly visible on the wall.
  const wall = await (await fetch(`${base}/api/wall`)).json();
  ok(
    wall.bricks.some((b) => b.id === created.brickId && b.displayName === 'SMOKE INC'),
    'brick appears on the public wall',
  );

  // 5. Admin endpoints: gated and able to see the brick.
  const noToken = await fetch(`${base}/api/admin/bricks`);
  ok(noToken.status === 401, 'admin endpoint rejects missing token');
  const adminList = await (
    await fetch(`${base}/api/admin/bricks`, { headers: { 'x-admin-token': ADMIN_TOKEN } })
  ).json();
  const adminBrick = adminList.bricks.find((b) => b.id === created.brickId);
  ok(adminBrick?.status === 'active', 'admin sees the active brick');

  // 6. The brick appears in a real public match (cache invalidated by webhook).
  const p1 = new Client('brick1');
  const p2 = new Client('brick2');
  await p1.connect();
  await p2.connect();
  p1.send({ t: 'join', nickname: 'brick1', mode: { kind: 'quick' } });
  await p1.waitFor((m) => m.t === 'joined', 3000, 'joined');
  p2.send({ t: 'join', nickname: 'brick2', mode: { kind: 'quick' } });
  await p2.waitFor((m) => m.t === 'joined', 3000, 'joined');
  p1.send({ t: 'ready', ready: true });
  p2.send({ t: 'ready', ready: true });
  const snap = await p1.waitFor(
    (m) => m.t === 'snapshot' && m.bricks.length > 0,
    5000,
    'branded snapshot',
  );
  const placed = snap.bricks[0];
  ok(placed.id === created.brickId && placed.tiles.length === 3, 'brick placed in the match');
  ok(placed.y % 2 === 0, 'brick sits on a pillar-free row');

  // 7. End the round (p2 self-destructs) -> appearance stats are flushed.
  p2.send({ t: 'bomb' });
  await p1.waitFor((m) => m.t === 'room' && m.state === 'roundEnd', 6000, 'round end');
  await sleep(300);
  const statsList = await (
    await fetch(`${base}/api/admin/bricks`, { headers: { 'x-admin-token': ADMIN_TOKEN } })
  ).json();
  const after = statsList.bricks.find((b) => b.id === created.brickId);
  ok(after.stats.appearances >= 1, `appearance stats recorded (${after.stats.appearances})`);

  // 8. Kill switch removes it from rotation.
  await fetch(`${base}/api/admin/bricks/${created.brickId}/deactivate`, {
    method: 'POST',
    headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'smoke cleanup' }),
  });
  const wallAfter = await (await fetch(`${base}/api/wall`)).json();
  ok(!wallAfter.bricks.some((b) => b.id === created.brickId), 'deactivated brick leaves the wall');

  for (const c of [p1, p2]) {
    c.send({ t: 'leave' });
    c.close();
  }
}

async function main() {
  rmSync(SMOKE_DATA, { recursive: true, force: true });
  const server = spawn('node', ['dist/server.cjs'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: `${SMOKE_DATA}/blastmates.db`,
      UPLOADS_DIR: `${SMOKE_DATA}/uploads`,
      LEMONSQUEEZY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      ADMIN_TOKEN,
      READY_TIMEOUT_MS: String(READY_TIMEOUT_SMOKE_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => console.error(`[server] ${d}`));
  try {
    await waitForServer();
    await testQuickMatch();
    await testReadyTimerAndBots();
    await testPrivateLobby();
    await testBrickFlow();
  } finally {
    server.kill();
  }
  if (failures > 0) {
    console.error(`\n${failures} smoke check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nall smoke checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
