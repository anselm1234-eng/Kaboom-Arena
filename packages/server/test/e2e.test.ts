import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parseServerMessage,
  type ClientMessage,
  type JoinedMessage,
  type RoomMessage,
  type ServerMessage,
  type SnapshotMessage,
} from '@blastmates/shared';

/**
 * End-to-end: boots the real server (real sockets, permessage-deflate, and
 * the broadcast serialization cache) and plays through a private room's
 * lifecycle: create, join, start, snapshots, input, rejoin, mid-game join.
 */

const SERVER_ROOT = path.resolve(__dirname, '..');
const PORT = 21000 + (process.pid % 1000);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A real websocket client; waitFor consumes messages in arrival order. */
class TestClient {
  private msgs: ServerMessage[] = [];
  private cursor = 0;
  private constructor(readonly ws: WebSocket) {}

  static connect(): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const client = new TestClient(ws);
      ws.on('message', (data) => {
        const msg = parseServerMessage(String(data));
        // Every frame must parse: catches corruption from caching/compression.
        if (!msg) throw new Error(`unparseable server message: ${String(data)}`);
        client.msgs.push(msg);
      });
      ws.on('open', () => resolve(client));
      ws.on('error', reject);
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Next message (from where the last match left off) satisfying pred. */
  async waitFor<T extends ServerMessage>(
    pred: (m: ServerMessage) => boolean,
    label: string,
    timeoutMs = 5_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      while (this.cursor < this.msgs.length) {
        const m = this.msgs[this.cursor++]!;
        if (pred(m)) return m as T;
      }
      await sleep(10);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  waitForSnapshot(
    pred: (s: SnapshotMessage) => boolean,
    label: string,
    timeoutMs = 5_000,
  ): Promise<SnapshotMessage> {
    return this.waitFor((m) => m.t === 'snapshot' && pred(m as SnapshotMessage), label, timeoutMs);
  }

  close(): void {
    this.ws.close();
  }
}

let server: ChildProcess;
let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'blastmates-e2e-'));
  server = spawn(path.join(SERVER_ROOT, 'node_modules/.bin/tsx'), ['src/server.ts'], {
    cwd: SERVER_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: path.join(dataDir, 'test.db'),
      UPLOADS_DIR: path.join(dataDir, 'uploads'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15_000);
    server.stdout!.on('data', (chunk: Buffer) => {
      if (String(chunk).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
  });
}, 20_000);

afterAll(() => {
  server?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('server e2e over real websockets', () => {
  let alice: TestClient;
  let bob: TestClient;
  let joinedA: JoinedMessage;
  let joinedB: JoinedMessage;

  it('creates a private room and negotiates permessage-deflate', async () => {
    alice = await TestClient.connect();
    expect(alice.ws.extensions).toContain('permessage-deflate');

    alice.send({ t: 'join', nickname: 'Alice', mode: { kind: 'create' } });
    joinedA = await waitJoined(alice);
    expect(joinedA.isPrivate).toBe(true);
    expect(joinedA.spectator).toBe(false);
    expect(joinedA.token).toBeTruthy();

    // A fresh lobby is seeded with bots (half the cap); clear them so the rest
    // of this suite exercises the pure two-human lifecycle it was written for.
    const seeded = await waitRoom(alice, (r) => r.players.some((p) => p.bot), 'seeded bots');
    expect(seeded.players.filter((p) => p.bot).length).toBeGreaterThan(0);
    for (const bot of seeded.players.filter((p) => p.bot)) {
      alice.send({ t: 'removeBot', botId: bot.id });
    }

    const room = await waitRoom(
      alice,
      (r) => r.players.length === 1 && !r.players.some((p) => p.bot),
      '1-player room',
    );
    expect(room.hostId).toBe(joinedA.playerId);
  });

  it('lets a second player join; both connections get the roster update', async () => {
    bob = await TestClient.connect();
    bob.send({ t: 'join', nickname: 'Bob', mode: { kind: 'join', roomId: joinedA.roomId } });
    joinedB = await waitJoined(bob);
    expect(joinedB.roomId).toBe(joinedA.roomId);

    // The same broadcast object is serialized once and fanned out: both
    // clients must see an identical, uncorrupted 2-player roster.
    for (const client of [alice, bob]) {
      const room = await waitRoom(client, (r) => r.players.length === 2, '2-player room');
      expect(room.players.map((p) => p.nickname).sort()).toEqual(['Alice', 'Bob']);
    }
  });

  it('starts the match and streams coherent snapshots to everyone', async () => {
    alice.send({ t: 'start' });
    await waitRoom(alice, (r) => r.state === 'countdown', 'countdown');

    // Pre-match countdown is 3s; then 20Hz snapshots begin.
    const first = await alice.waitForSnapshot(() => true, 'first snapshot', 8_000);
    expect(first.grid.length).toBeGreaterThan(0);
    expect(first.players.map((p) => p.id).sort()).toEqual(
      [joinedA.playerId, joinedB.playerId].sort(),
    );

    const second = await alice.waitForSnapshot((s) => s.tick > first.tick, 'tick advances');
    expect(second.serverTime).toBeGreaterThanOrEqual(first.serverTime);
    await bob.waitForSnapshot(() => true, 'bob receives snapshots too', 8_000);
  });

  it('applies inputs: a player moves and can drop a bomb', async () => {
    const before = await alice.waitForSnapshot(() => true, 'position before move');
    const me = (s: SnapshotMessage) => s.players.find((p) => p.id === joinedA.playerId)!;

    alice.send({ t: 'input', dir: 'right' });
    const after = await alice.waitForSnapshot(
      (s) => me(s).x > me(before).x + 0.3,
      'player moved right',
    );
    expect(me(after).x).toBeGreaterThan(me(before).x);
    alice.send({ t: 'input', dir: null });

    alice.send({ t: 'bomb' });
    const withBomb = await alice.waitForSnapshot(
      (s) => s.bombs.some((b) => b.ownerId === joinedA.playerId),
      'bomb appears',
    );
    expect(withBomb.bombs.length).toBeGreaterThan(0);
  });

  it('supports rejoin after a dropped connection', async () => {
    bob.close();
    // A mid-match disconnect kills the player's entity; with two fighters
    // that ends the round in Alice's favor.
    await waitRoom(
      alice,
      (r) => r.state === 'roundEnd' && r.winnerId === joinedA.playerId,
      'round ends when bob drops',
    );

    bob = await TestClient.connect();
    bob.send({
      t: 'join',
      nickname: 'Bob',
      mode: { kind: 'join', roomId: joinedA.roomId },
      rejoinToken: joinedB.token,
    });
    const rejoined = await waitJoined(bob);
    expect(rejoined.playerId).toBe(joinedB.playerId);
    // Rejoiners during playing/roundEnd spectate until the next round.
    expect(rejoined.spectator).toBe(true);
    await waitRoom(
      alice,
      (r) => r.players.some((p) => p.id === joinedB.playerId && p.connected),
      'alice sees bob reconnected',
    );

    // Private rooms roll into the next round ~5s after round end, where the
    // rejoined player is re-seated as a fighter.
    const snap = await bob.waitForSnapshot(
      (s) => s.players.some((p) => p.id === joinedB.playerId && p.alive),
      'bob fights again in the next round',
      10_000,
    );
    expect(snap.players.map((p) => p.id).sort()).toEqual(
      [joinedA.playerId, joinedB.playerId].sort(),
    );
  }, 15_000);

  it('seats a mid-game joiner as a spectator who still gets snapshots', async () => {
    const carol = await TestClient.connect();
    carol.send({ t: 'join', nickname: 'Carol', mode: { kind: 'join', roomId: joinedA.roomId } });
    const joinedC = await waitJoined(carol);
    expect(joinedC.spectator).toBe(true);
    await carol.waitForSnapshot(() => true, 'spectator receives snapshots');
    carol.close();
  });

  it('seeds a freshly created public room with bots on quick match', async () => {
    const erin = await TestClient.connect();
    erin.send({ t: 'join', nickname: 'Erin', mode: { kind: 'quick' } });
    const joinedE = await waitJoined(erin);
    expect(joinedE.isPrivate).toBe(false);

    const room = await waitRoom(erin, (r) => r.players.some((p) => p.bot), 'public room with bots');
    // The human is listed first; the seeded bots fill in behind them.
    expect(room.players[0]!.id).toBe(joinedE.playerId);
    expect(room.players[0]!.bot).toBeFalsy();
    expect(room.players.filter((p) => p.bot).length).toBeGreaterThan(0);
    erin.close();
  });

  it('rejects an expired rejoin token instead of silently joining', async () => {
    const dave = await TestClient.connect();
    dave.send({
      t: 'join',
      nickname: 'Dave',
      mode: { kind: 'join', roomId: joinedA.roomId },
      rejoinToken: 'no-such-token',
    });
    const err = await dave.waitFor((m) => m.t === 'error', 'rejoin error');
    expect(err).toMatchObject({ t: 'error', code: 'rejoin_failed' });
    dave.close();
  });
});

function waitJoined(client: TestClient): Promise<JoinedMessage> {
  return client.waitFor<JoinedMessage>((m) => m.t === 'joined', 'joined message');
}

function waitRoom(
  client: TestClient,
  pred: (r: RoomMessage) => boolean,
  label: string,
): Promise<RoomMessage> {
  return client.waitFor<RoomMessage>((m) => m.t === 'room' && pred(m as RoomMessage), label);
}
