import dotenvFlow from 'dotenv-flow';
dotenvFlow.config({ default_node_env: 'development' });

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  TICK_MS,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from '@blastmates/shared';
import { createApi } from './api';
import { createAuth } from './auth';
import { BrickCache, BrickEngagementBuffer } from './bricks';
import { loadConfig } from './config';
import { createMailer } from './email';
import { createLsClient } from './ls';
import { RoomManager } from './manager';
import { RateLimiter, clientIp } from './ratelimit';
import { Room, RoomError, type ClientConn, type RosterPlayer } from './room';
import { Store, seedDevAccounts } from './store';

const cfg = loadConfig();
const PORT = cfg.port;
const CLIENT_DIST = cfg.clientDist;

// Without APP_ORIGIN, email links derive their origin from the request Host
// header, which a client controls - a host-header-injection vector for
// password-reset links. Setting APP_ORIGIN makes link generation ignore the
// request entirely, so it is effectively required once real email is on.
if (cfg.resendApiKey && !cfg.appOrigin) {
  console.warn(
    'WARNING: RESEND_API_KEY is set but APP_ORIGIN is not. Set APP_ORIGIN to ' +
      'your canonical https origin so password-reset/verify links cannot be ' +
      'spoofed via the Host header.',
  );
}

const store = new Store(cfg.dbPath);
// Dev convenience login (john@example.com / password); never seeded in prod.
if (process.env.NODE_ENV !== 'production') {
  void seedDevAccounts(store).catch((err) => console.error('dev seed failed', err));
}
const brickCache = new BrickCache(store);
/** Coalesces client-reported brick views/clicks; flushed to the store below. */
const brickEngagement = new BrickEngagementBuffer();
const ls = createLsClient(cfg.lsApiKey);
const mailer = createMailer(cfg.resendApiKey, cfg.emailFrom);
const auth = createAuth({ store, cfg, mailer });

const manager = new RoomManager(Math.random, {
  brickCandidates: () => brickCache.candidates(Date.now()),
  onBrickStats: (stats) => store.addStats(stats),
  suddenDeath: cfg.suddenDeath,
  afk: cfg.afk,
  publicStart: cfg.publicStart,
});

const api = createApi({
  store,
  cache: brickCache,
  ls,
  cfg,
  manager,
  accountForRequest: (req) => auth.accountForRequest(req),
});

interface Session {
  room: Room;
  player: RosterPlayer;
  /** Account behind the connection (cookie on the WS upgrade); null = no cookie. */
  accountId: string | null;
}

/** Failed password attempts per IP; correct passwords are never throttled away silently. */
const passwordLimiter = new RateLimiter(5, 60_000);

/**
 * Broadcasts pass the same message object to every connection in a room;
 * caching by identity serializes each broadcast once instead of per socket.
 */
const serialized = new WeakMap<ServerMessage, string>();

class WsConn implements ClientConn {
  constructor(private readonly ws: WebSocket) {}
  send(msg: ServerMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    let json = serialized.get(msg);
    if (json === undefined) {
      json = JSON.stringify(msg);
      serialized.set(msg, json);
    }
    this.ws.send(json);
  }
}

function sendError(conn: ClientConn, code: ErrorCode, message: string): void {
  conn.send({ t: 'error', code, message });
}

function handleJoin(
  conn: WsConn,
  msg: Extract<ClientMessage, { t: 'join' }>,
  session: Session | null,
  ip: string,
  accountId: string | null,
): Session | null {
  if (session) {
    sendError(conn, 'already_joined', 'Already in a room');
    return session;
  }
  const now = Date.now();

  // Reconnect path: a valid token reattaches the old roster entry.
  if (msg.rejoinToken) {
    const found = manager.lookupToken(msg.rejoinToken);
    if (found) {
      const player = found.room.rejoin(found.playerId, conn, now);
      if (player) {
        conn.send({
          t: 'joined',
          playerId: player.id,
          roomId: found.room.id,
          roomName: found.room.name,
          token: player.token,
          isPrivate: found.room.isPrivate,
          spectator: player.spectator,
          localPlayerIds: found.room.localPlayersOf(player.id).map((p) => p.id),
        });
        found.room.broadcastRoom(now);
        return { room: found.room, player, accountId };
      }
    }
    if (msg.mode.kind === 'quick') {
      // Fall through to a fresh quick match if the token expired.
    } else {
      sendError(conn, 'rejoin_failed', 'Reconnect window expired');
      return null;
    }
  }

  let room: Room;
  // A freshly created lobby (private "create", or a public quick-match that had
  // to spin up a new room) gets seeded with bots once the human is in - see the
  // fillInitialBots call below. Joining an existing match leaves its roster alone.
  let seedBots = false;
  if (msg.mode.kind === 'quick') {
    room = manager.quickMatch(msg.mode.size);
    seedBots = room.roster.size === 0;
  } else if (msg.mode.kind === 'create') {
    room = manager.createPrivate(msg.mode.size, msg.mode.password);
    seedBots = true;
  } else {
    const existing = manager.get(msg.mode.roomId);
    if (!existing) {
      sendError(conn, 'room_not_found', 'Room not found');
      return null;
    }
    if (existing.hasPassword()) {
      if (passwordLimiter.blocked(ip, now)) {
        sendError(conn, 'rate_limited', 'Too many password attempts - try again in a minute');
        return null;
      }
      if (msg.mode.password === undefined) {
        sendError(conn, 'password_required', 'This room requires a password');
        return null;
      }
      if (!existing.checkPassword(msg.mode.password)) {
        passwordLimiter.allow(ip, now); // a failed attempt consumes a slot
        sendError(conn, 'bad_password', 'Wrong password');
        return null;
      }
    }
    room = existing;
  }

  let player: RosterPlayer;
  try {
    player = room.addPlayer(msg.nickname, conn, now, msg.skin);
  } catch (err) {
    if (err instanceof RoomError) {
      sendError(conn, err.code === 'room_full' ? 'room_full' : 'cannot_start', err.message);
      return null;
    }
    throw err;
  }
  manager.registerToken(player.token, room.id, player.id);
  // The played nickname sticks to the account; the latest rewrite wins.
  if (accountId) store.setAccountNickname(accountId, player.nickname, now);
  conn.send({
    t: 'joined',
    playerId: player.id,
    roomId: room.id,
    roomName: room.name,
    token: player.token,
    isPrivate: room.isPrivate,
    spectator: player.spectator,
  });
  // Seed half the cap with bots (4→2, 6→3, 8→4) now that the human is in, so the
  // player is listed first and opponents fill in behind them. Fresh lobbies only.
  if (seedBots) room.fillInitialBots(now);
  room.broadcastRoom(now);
  return { room, player, accountId };
}

function handleMessage(
  conn: WsConn,
  raw: string,
  session: Session | null,
  ip: string,
  accountId: string | null,
): Session | null {
  const msg = parseClientMessage(raw);
  if (!msg) {
    sendError(conn, 'bad_message', 'Invalid message');
    return session;
  }
  if (msg.t === 'join') return handleJoin(conn, msg, session, ip, accountId);
  if (!session) return null;

  const now = Date.now();
  if (msg.t === 'input') {
    const pid = msg.pid ?? session.player.id;
    if (session.room.ownsPlayer(session.player.id, pid)) {
      session.room.handleInput(pid, msg.dir, now);
    }
  } else if (msg.t === 'bomb') {
    const pid = msg.pid ?? session.player.id;
    if (session.room.ownsPlayer(session.player.id, pid)) {
      session.room.handleBomb(pid, now);
    }
  } else if (msg.t === 'start') {
    try {
      session.room.startByHost(session.player.id, now);
    } catch (err) {
      if (err instanceof RoomError) {
        sendError(conn, err.code, err.message);
      } else {
        throw err;
      }
    }
  } else if (msg.t === 'ready') {
    try {
      const pid = msg.pid ?? session.player.id;
      session.room.setReady(session.player.id, pid, msg.ready, now);
    } catch (err) {
      if (err instanceof RoomError) {
        sendError(conn, err.code, err.message);
      } else {
        throw err;
      }
    }
  } else if (msg.t === 'addBot') {
    try {
      session.room.addBot(session.player.id, now, msg.difficulty ?? 'normal');
    } catch (err) {
      if (err instanceof RoomError) {
        sendError(conn, err.code, err.message);
      } else {
        throw err;
      }
    }
  } else if (msg.t === 'setSize') {
    try {
      session.room.setSize(session.player.id, msg.size, now);
    } catch (err) {
      if (err instanceof RoomError) {
        sendError(conn, err.code, err.message);
      } else {
        throw err;
      }
    }
  } else if (msg.t === 'removeBot') {
    try {
      session.room.removeBot(session.player.id, msg.botId, now);
    } catch (err) {
      if (err instanceof RoomError) {
        sendError(conn, err.code, err.message);
      } else {
        throw err;
      }
    }
  } else if (msg.t === 'kick') {
    try {
      session.room.kickPlayer(session.player.id, msg.playerId, now);
    } catch (err) {
      if (err instanceof RoomError) {
        sendError(conn, err.code, err.message);
      } else {
        throw err;
      }
    }
  } else if (msg.t === 'addLocal') {
    try {
      session.room.addLocalPlayer(session.player.id, now, msg.nickname);
    } catch (err) {
      if (err instanceof RoomError) {
        sendError(conn, err.code, err.message);
      } else {
        throw err;
      }
    }
  } else if (msg.t === 'removeLocal') {
    try {
      session.room.removeLocalPlayer(session.player.id, msg.playerId, now);
    } catch (err) {
      if (err instanceof RoomError) {
        sendError(conn, err.code, err.message);
      } else {
        throw err;
      }
    }
  } else if (msg.t === 'renameLocal') {
    try {
      session.room.renameLocalPlayer(session.player.id, msg.playerId, msg.nickname, now);
    } catch (err) {
      if (err instanceof RoomError) {
        sendError(conn, err.code, err.message);
      } else {
        throw err;
      }
    }
  } else if (msg.t === 'leave') {
    session.room.removeConnection(session.player.id, now);
    return null;
  } else if (msg.t === 'brickEvent') {
    // Count only bricks actually placed in this player's live match, so a
    // client can't inflate a brand's stats for bricks it never saw.
    if (session.room.hasPlacedBrick(msg.id)) brickEngagement.record(msg.id, msg.kind);
  }
  return session;
}

// --- Rooms API (join-screen previews + the home-screen room browser) ---

const roomsLimiter = new RateLimiter(120, 60_000);

function serveRoomsApi(req: IncomingMessage, res: ServerResponse): boolean {
  const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
  if (req.method !== 'GET' || !urlPath.startsWith('/api/rooms')) return false;
  const sendJson = (status: number, body: unknown): true => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
    return true;
  };
  if (!roomsLimiter.allow(clientIp(req), Date.now())) {
    return sendJson(429, { error: 'rate limited' });
  }
  if (urlPath === '/api/rooms') {
    return sendJson(200, { rooms: manager.listPublicRooms() });
  }
  const m = /^\/api\/rooms\/([a-z0-9]{1,32})$/i.exec(urlPath);
  if (m?.[1]) {
    const info = manager.roomInfo(m[1].toLowerCase());
    return info ? sendJson(200, { room: info }) : sendJson(404, { error: 'Room not found' });
  }
  return false;
}

// --- Static file serving (production: client build) ---

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
  if (!existsSync(CLIENT_DIST)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Client build not found. Run the client with Vite in development.');
    return;
  }
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(CLIENT_DIST, safePath);
  if (!filePath.startsWith(CLIENT_DIST)) {
    res.writeHead(403);
    res.end();
    return;
  }
  // SPA fallback for /room/:id and friends.
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = path.join(CLIENT_DIST, 'index.html');
  }
  try {
    const data = readFileSync(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

// --- Wiring ---

const httpServer = createServer((req, res) => {
  if (auth.handle(req, res)) return;
  if (serveRoomsApi(req, res)) return;
  if (api(req, res)) return;
  serveStatic(req, res);
});
const wss = new WebSocketServer({
  server: httpServer,
  // Snapshot JSON is highly repetitive and compresses ~4x; bandwidth is the
  // first scaling ceiling, so trade a little CPU for it. No-context-takeover
  // and a small window keep per-socket zlib memory bounded.
  perMessageDeflate: {
    threshold: 1024, // small messages (room/error/afk) go uncompressed
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
    serverMaxWindowBits: 10,
    concurrencyLimit: 10,
    zlibDeflateOptions: { level: 3, memLevel: 7, chunkSize: 1024 },
  },
});

wss.on('connection', (ws, req) => {
  const conn = new WsConn(ws);
  const ip = clientIp(req);
  // The auth cookie rides along on the WS upgrade: gameplay is tied to the
  // (possibly anonymous) account, so progression can credit it later.
  const accountId = auth.accountIdForRequest(req);
  let session: Session | null = null;

  ws.on('message', (data) => {
    try {
      session = handleMessage(conn, String(data), session, ip, accountId);
    } catch (err) {
      console.error('error handling message', err);
    }
  });

  ws.on('close', () => {
    if (session) {
      session.room.handleDisconnect(session.player.id, Date.now());
      session = null;
    }
  });

  ws.on('error', () => {
    ws.close();
  });
});

setInterval(() => {
  manager.tickAll(Date.now());
}, TICK_MS);

// Persist accumulated brick views/clicks in periodic batches (a burst of hovers
// becomes one transaction, not one write per event).
setInterval(() => {
  store.addEngagement(brickEngagement.flush());
}, 15_000);

httpServer.listen(PORT, () => {
  console.log(`blastmates server listening on :${PORT}`);
});
