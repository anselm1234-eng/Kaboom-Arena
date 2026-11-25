import {
  ROOM_SIZE_GRID,
  TILE_CRATE,
  TILE_EMPTY,
  generateMap,
  gridToString,
  mulberry32,
  tileIndex,
  type JoinedMessage,
  type PlayerSnapshot,
  type RoomMessage,
  type SnapshotMessage,
} from '@blastmates/shared';
import type { Fx } from './fx';
import { drawTextCentered } from './font';
import { color } from './palette';
import type { BannerState } from './render';
import type { SnapshotBuffer } from './snapshots';

/** Synthetic branded-crate tiles (data URLs) for visual verification. */
function demoBrickTiles(): string[] {
  const canvas = document.createElement('canvas');
  canvas.width = 48;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  ctx.fillStyle = color(1);
  ctx.fillRect(0, 0, 48, 16);
  ctx.fillStyle = color(12);
  ctx.fillRect(0, 0, 48, 3);
  ctx.fillRect(0, 13, 48, 3);
  drawTextCentered(ctx, 'ACME', 24, 6, 10, 0, 1);
  const tiles: string[] = [];
  for (let i = 0; i < 3; i++) {
    const tile = document.createElement('canvas');
    tile.width = 16;
    tile.height = 16;
    const tctx = tile.getContext('2d');
    if (!tctx) continue;
    tctx.drawImage(canvas, -i * 16, 0);
    tiles.push(tile.toDataURL());
  }
  return tiles;
}

/**
 * Offline demo scenes for visual verification (?demo=lobby|start|game|explosion|win).
 * Feeds synthetic snapshots into the normal render path — no server needed.
 * `&bare=1` hides the DOM HUD so screenshots contain only canvas pixels.
 */

export interface DemoDeps {
  buffer: SnapshotBuffer;
  fx: Fx;
  showScreen: (name: 'landing' | 'lobby' | 'game') => void;
  setRoom: (room: RoomMessage) => void;
  setJoined: (joined: JoinedMessage) => void;
  setBanner: (banner: BannerState | null) => void;
  setRoundStartAt: (t: number | null) => void;
  /** Render one frame at the given server-time offset (for benchmarking). */
  benchFrame: (serverNowOffset: number) => void;
}

const NICKS = ['ALICE', 'BOB', 'CAROL', 'DAVE'];

/** Demo rooms are 4-player rooms; all scene coordinates live on that grid. */
const DEMO_SIZE = 4;
const DEMO_W = ROOM_SIZE_GRID[DEMO_SIZE].width; // 13
const DEMO_H = ROOM_SIZE_GRID[DEMO_SIZE].height; // 11
const ti = (x: number, y: number): number => tileIndex(x, y, DEMO_W);

function demoGrid(): { before: string; after: string } {
  const g = generateMap(DEMO_SIZE, mulberry32(7));
  // Carve corridors so demo actors stand on open ground.
  for (let x = 0; x <= 6; x++) g[ti(x, 0)] = TILE_EMPTY;
  for (let y = 7; y <= DEMO_H - 1; y++) g[ti(0, y)] = TILE_EMPTY;
  for (let x = 7; x <= DEMO_W - 1; x++) g[ti(x, DEMO_H - 1)] = TILE_EMPTY;
  for (let x = 3; x <= 9; x++) g[ti(x, 6)] = TILE_EMPTY;
  for (const [x, y] of [
    [4, 2],
    [10, 4],
    [7, 8],
  ] as const) {
    g[ti(x, y)] = TILE_EMPTY;
  }
  g[ti(4, 6)] = TILE_CRATE;
  g[ti(8, 6)] = TILE_CRATE;
  // Branded crate cluster shown in the game/start scenes.
  for (let x = 5; x <= 7; x++) g[ti(x, 4)] = TILE_CRATE;
  const before = gridToString(g);
  g[ti(4, 6)] = TILE_EMPTY;
  g[ti(8, 6)] = TILE_EMPTY;
  return { before, after: gridToString(g) };
}

function basePlayer(id: string, x: number, y: number): PlayerSnapshot {
  return { id, x, y, dir: null, alive: true, bombCap: 2, range: 3, speed: 3.5 };
}

function roomMsg(state: RoomMessage['state'], now: number, winnerId: string | null): RoomMessage {
  return {
    t: 'room',
    roomId: 'demo01',
    roomName: 'DEMO DOJO',
    state,
    isPrivate: false,
    hostId: null,
    maxPlayers: 4,
    countdownEndsAt: state === 'roundEnd' ? now + 4000 : state === 'countdown' ? now + 3000 : null,
    winnerId,
    readyTimerEndsAt: null,
    serverTime: now,
    players: NICKS.map((nickname, i) => ({
      id: `d${i + 1}`,
      nickname,
      connected: true,
      spectator: false,
      ready: true,
      wins: [2, 1, 0, 3][i] ?? 0,
      // CAROL shows off the skin pack: gold palette, top hat, bounce dance.
      ...(i === 2 ? { skin: { palette: 'gold', hat: 'tophat', dance: 'bounce' } } : {}),
    })),
  };
}

/** Triangle wave in [0, span). */
function tri(t: number, span: number): number {
  const u = (t / 1000) % (span * 2);
  return u < span ? u : span * 2 - u;
}

/**
 * Synchronous worst-case render benchmark: 4 players, a chained explosion
 * covering whole lanes, fresh crumbles and a death — 300 frames, then the
 * average cost lands in #perf-result (readable via --dump-dom).
 */
function runBench(deps: DemoDeps, before: string, after: string): void {
  const now = performance.now();
  const players = [
    basePlayer('d1', 0.5, 0.5),
    basePlayer('d2', 9.5, 6.5),
    basePlayer('d3', 0.5, DEMO_H - 0.5),
    basePlayer('d4', DEMO_W - 0.5, DEMO_H - 0.5),
  ];
  players.forEach((p) => (p.dir = 'right'));
  const cells = [];
  for (let x = 0; x < DEMO_W; x++) cells.push({ x, y: 6 });
  for (let y = 0; y < DEMO_H; y++) if (y !== 6) cells.push({ x: 6, y });
  const pre: SnapshotMessage = {
    t: 'snapshot',
    tick: 0,
    serverTime: now - 50,
    grid: before,
    players,
    bombs: [{ id: 'b1', x: 6, y: 6, ownerId: 'd1', explodesAt: now }],
    explosions: [],
    powerups: [{ id: 'u1', x: 4, y: 2, kind: 'range' }],
    bricks: [],
  };
  const post: SnapshotMessage = {
    ...pre,
    tick: 1,
    serverTime: now,
    grid: after,
    bombs: [],
    explosions: [{ id: 'e1', cells, endsAt: now + 500 }],
    players: players.map((p, i) => (i === 1 ? { ...p, alive: false } : p)),
  };
  deps.buffer.push(pre);
  deps.fx.process(pre);
  deps.buffer.push(post);
  deps.fx.process(post);

  const N = 300;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) deps.benchFrame((i % 30) * 16.7);
  const avg = (performance.now() - t0) / N;
  const node = document.createElement('div');
  node.id = 'perf-result';
  node.style.display = 'none';
  node.textContent = `avg=${avg.toFixed(3)}ms/frame max-load (${(1000 / avg).toFixed(0)} fps headroom)`;
  document.body.appendChild(node);
}

export function maybeStartDemo(deps: DemoDeps): boolean {
  const params = new URLSearchParams(location.search);
  const scene = params.get('demo');
  if (!scene) return false;
  if (params.get('bare') === '1') document.body.classList.add('bare');

  const { before, after } = demoGrid();
  const t0 = performance.now();

  deps.setJoined({
    t: 'joined',
    playerId: params.get('guest') === '1' ? 'd2' : 'd1',
    roomId: 'demo01',
    roomName: 'DEMO DOJO',
    token: 'demo',
    isPrivate: false,
    spectator: false,
  });

  if (scene === 'lobby') {
    deps.setRoom(roomMsg('lobby', performance.now(), null));
    deps.showScreen('lobby');
    return true;
  }

  if (params.get('perf') === '1') {
    deps.setRoom(roomMsg('playing', performance.now(), null));
    deps.setRoundStartAt(t0 - 10_000);
    deps.showScreen('game');
    runBench(deps, before, after);
    return true;
  }

  const brickTiles = demoBrickTiles();
  deps.setRoom(
    roomMsg(scene === 'win' ? 'roundEnd' : 'playing', performance.now(), scene === 'win' ? 'd3' : null),
  );
  deps.setRoundStartAt(scene === 'start' ? null : t0 - 10_000);
  if (scene === 'start') {
    deps.setBanner({ lines: [{ text: 'READY...', colorIdx: 10, scale: 2 }] });
  }
  deps.showScreen('game');

  const CYCLE = 2500;
  const BOOM_AT = 1200;
  const BOOM_LEN = 500;

  function snapshot(now: number): SnapshotMessage {
    const t = now - t0;
    const players = [
      basePlayer('d1', 0.5 + tri(t, 5), 0.5),
      basePlayer('d2', 9.5, 6.5),
      basePlayer('d3', 0.5, DEMO_H - 0.5 - tri(t, 3)),
      basePlayer('d4', DEMO_W - 0.5 - tri(t, 5), DEMO_H - 0.5),
    ];
    const p1 = players[0]!;
    const p3 = players[2]!;
    const p4 = players[3]!;
    p1.dir = Math.floor(t / 5000) % 2 === 0 ? 'right' : 'left';
    p3.dir = 'up';
    p4.dir = 'left';

    const snap: SnapshotMessage = {
      t: 'snapshot',
      tick: Math.floor(t / 50),
      serverTime: now,
      grid: before,
      players,
      bombs: [],
      explosions: [],
      powerups: [
        { id: 'u1', x: 4, y: 2, kind: 'range' },
        { id: 'u2', x: 10, y: 4, kind: 'bomb' },
        { id: 'u3', x: 7, y: 8, kind: 'speed' },
      ],
      bricks:
        scene === 'explosion' || brickTiles.length === 0
          ? []
          : [
              {
                id: 'demo-brick',
                x: 5,
                y: 4,
                tiles: brickTiles,
                name: 'ACME',
                link: 'https://example.com',
              },
            ],
    };

    if (scene === 'explosion') {
      const cycleN = Math.floor(t / CYCLE);
      const ct = t - cycleN * CYCLE;
      const cycleStart = t0 + cycleN * CYCLE;
      if (ct < BOOM_AT) {
        snap.bombs.push({ id: `b${cycleN}`, x: 7, y: 6, ownerId: 'd2', explodesAt: cycleStart + BOOM_AT });
      } else {
        snap.grid = after;
        const cells = [];
        for (let x = 4; x <= 8; x++) cells.push({ x, y: 6 });
        snap.explosions.push({ id: `e${cycleN}`, cells, endsAt: cycleStart + BOOM_AT + BOOM_LEN });
        const p2 = snap.players[1];
        if (p2) p2.alive = false;
      }
    } else if (scene !== 'win') {
      // Steady ticking bomb so the pulse is visible.
      const cycleN = Math.floor(t / 3000);
      snap.bombs.push({ id: `b${cycleN}`, x: 6, y: 6, ownerId: 'd2', explodesAt: t0 + (cycleN + 1) * 3000 });
    }

    if (scene === 'win') {
      for (const p of snap.players.slice(1)) p.alive = false;
      snap.players.forEach((p) => (p.dir = null));
    }

    return snap;
  }

  // Prime fx with an initial snapshot so the win scene has no false deaths.
  const first = snapshot(performance.now());
  deps.buffer.push(first);
  deps.fx.process(first);

  setInterval(() => {
    const now = performance.now();
    const snap = snapshot(now);
    deps.buffer.push(snap);
    deps.fx.process(snap);
    if (scene === 'win') deps.setRoom(roomMsg('roundEnd', now, 'd3'));
  }, 50);

  return true;
}
