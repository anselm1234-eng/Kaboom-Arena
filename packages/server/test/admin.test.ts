import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../src/api';
import { BrickCache } from '../src/bricks';
import type { Config } from '../src/config';
import { createLsClient } from '../src/ls';
import { RoomManager } from '../src/manager';
import { Store, seedDevAccounts, type AccountRow } from '../src/store';
import { verifyPassword } from '../src/passwords';

function testCfg(uploadsDir: string): Config {
  return {
    port: 0,
    clientDist: '',
    suddenDeath: {},
    afk: {},
    publicStart: {},
    lsApiKey: null,
    lsWebhookSecret: null,
    lsStoreId: null,
    lsVariants: { brick1x1: null, brick2x1: null, brick3x1: null, skin: null },
    dbPath: ':memory:',
    uploadsDir,
    resendApiKey: null,
    emailFrom: 'Blastmates <test@example.com>',
    appOrigin: null,
  };
}

function brickInput(id: string): Parameters<Store['createActiveBrick']>[0] {
  return {
    id,
    size: 1,
    displayName: 'Acme',
    linkUrl: null,
    tilePaths: [`bricks/${id}/tile-0.png`],
    fullPath: `bricks/${id}/full.png`,
    originalPath: `bricks/${id}/original.png`,
    now: 1000,
  };
}

describe('store admin helpers', () => {
  it('grants admin by email idempotently and aggregates account stats', () => {
    const store = new Store(':memory:');
    const acc = store.createAccount('a'.repeat(32), 1);
    store.attachCredentials(acc.id, 'boss@example.com', 'hash');
    store.markEmailVerified(acc.id, 'boss@example.com');

    expect(store.grantAdminByEmail('BOSS@example.com')).toBe(true); // case-insensitive
    expect(store.getAccount(acc.id)?.isAdmin).toBe(true);
    expect(store.grantAdminByEmail('nobody@example.com')).toBe(false);

    const stats = store.accountStats();
    expect(stats.total).toBe(1);
    expect(stats.registered).toBe(1);
    expect(stats.verified).toBe(1);
    expect(stats.admins).toBe(1);
  });

  it('creates, edits and deletes free active bricks with stats', () => {
    const store = new Store(':memory:');
    const id = 'b'.repeat(32);
    const brick = store.createActiveBrick(brickInput(id));
    expect(brick.status).toBe('active');
    expect(brick.expiresAt).toBeGreaterThan(brick.createdAt);
    expect(brick.orderId).toBeNull(); // free: no order

    expect(store.updateBrickMeta(id, 'Renamed', 'https://x.test')).toBe(true);
    const updated = store.getBrick(id)!;
    expect(updated.displayName).toBe('Renamed');
    expect(updated.linkUrl).toBe('https://x.test');

    const bstats = store.brickStats();
    expect(bstats.total).toBe(1);
    expect(bstats.byStatus.active).toBe(1);

    const deleted = store.deleteBrick(id);
    expect(deleted?.id).toBe(id);
    expect(store.getBrick(id)).toBeNull();
  });

  it('keeps "forever" bricks active through the expire sweep', () => {
    const store = new Store(':memory:');
    const id = 'f'.repeat(32);
    const brick = store.createActiveBrick(brickInput(id));

    // Mark it forever: expiry is cleared.
    expect(store.setForever(id, true, 2000)).toBe(true);
    expect(store.getBrick(id)?.expiresAt).toBeNull();

    // Sweeping far in the future leaves it active (a normal brick would expire).
    store.expireSweep(brick.createdAt + 1_000 * 24 * 60 * 60 * 1000);
    expect(store.getBrick(id)?.status).toBe('active');
    expect(store.activeBricks(Date.now()).map((b) => b.id)).toContain(id);

    // Turning it off restores a finite window, and it would expire again.
    expect(store.setForever(id, false, 3000)).toBe(true);
    expect(store.getBrick(id)?.expiresAt).toBeGreaterThan(3000);
    store.expireSweep(Date.now() + 1_000 * 24 * 60 * 60 * 1000);
    expect(store.getBrick(id)?.status).toBe('expired');

    expect(store.setForever('0'.repeat(32), true, 4000)).toBe(false);
  });

  it('seeds the dev login once with a working password', async () => {
    const store = new Store(':memory:');
    expect(store.accountByEmail('john@example.com')).toBeNull(); // not seeded by migration
    await seedDevAccounts(store);
    const john = store.accountByEmail('john@example.com')!;
    expect(john.email).toBe('john@example.com');
    expect(john.emailVerified).toBe(true);
    expect(john.isAdmin).toBe(true); // dev seed is an admin, for testing the admin zone
    expect(await verifyPassword('password', john.passwordHash!)).toBe(true);
    // Idempotent: a second call is a no-op.
    await seedDevAccounts(store);
    expect(store.accountStats().total).toBe(1);
  });
});

describe('manager admin views', () => {
  it('reports online humans and live stats, excluding bots', () => {
    const manager = new RoomManager();
    const room = manager.quickMatch();
    const conns = { send: () => {} };
    room.addPlayer('Alice', conns, 1, undefined);
    room.addBot(room.connectedPlayers()[0]!.id, 2, 'normal');

    const online = manager.onlinePlayers();
    expect(online.map((p) => p.nickname)).toEqual(['Alice']);
    expect(online[0]?.isPrivate).toBe(false);

    const live = manager.liveStats();
    expect(live.humansOnline).toBe(1);
    expect(live.bots).toBe(1);
    expect(live.publicRooms).toBe(1);
    expect(live.rooms).toBe(1);
  });
});

describe('admin API gating and brick management', () => {
  let server: Server;
  let base: string;
  let store: Store;
  let uploadsDir: string;
  let current: AccountRow | null = null;

  beforeEach(async () => {
    uploadsDir = mkdtempSync(path.join(tmpdir(), 'bm-admin-'));
    store = new Store(':memory:');
    const cache = new BrickCache(store);
    const manager = new RoomManager();
    const api = createApi({
      store,
      cache,
      ls: createLsClient(null),
      cfg: testCfg(uploadsDir),
      manager,
      accountForRequest: () => current,
    });
    server = createServer((req, res) => {
      if (!api(req, res)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    server.close();
    store.close();
    rmSync(uploadsDir, { recursive: true, force: true });
    current = null;
  });

  function admin(): AccountRow {
    const acc = store.createAccount('c'.repeat(32), 1);
    store.attachCredentials(acc.id, 'admin@example.com', 'hash');
    store.grantAdminByEmail('admin@example.com');
    return store.getAccount(acc.id)!;
  }

  it('rejects anonymous (401) and non-admin (403) callers', async () => {
    current = null;
    expect((await fetch(`${base}/api/admin/summary`)).status).toBe(401);

    current = store.createAccount('d'.repeat(32), 1); // anon, not admin
    expect((await fetch(`${base}/api/admin/summary`)).status).toBe(403);
  });

  it('serves the summary for an admin', async () => {
    current = admin();
    const res = await fetch(`${base}/api/admin/summary`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accounts: { admins: number };
      live: { rooms: number };
      online: unknown[];
    };
    expect(body.accounts.admins).toBe(1);
    expect(body.live.rooms).toBe(0);
    expect(Array.isArray(body.online)).toBe(true);
  });

  it('lists, edits, deactivates and deletes bricks', async () => {
    current = admin();
    const id = 'e'.repeat(32);
    store.createActiveBrick(brickInput(id));

    const list = (await (await fetch(`${base}/api/admin/bricks`)).json()) as {
      bricks: Array<{ id: string }>;
    };
    expect(list.bricks.map((b) => b.id)).toContain(id);

    const edited = await fetch(`${base}/api/admin/bricks/${id}/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Edited', linkUrl: 'https://e.test' }),
    });
    expect(edited.status).toBe(200);
    expect(store.getBrick(id)?.displayName).toBe('Edited');

    const forever = await fetch(`${base}/api/admin/bricks/${id}/forever`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ forever: true }),
    });
    expect(forever.status).toBe(200);
    expect(store.getBrick(id)?.expiresAt).toBeNull();
    const listAfter = (await (await fetch(`${base}/api/admin/bricks`)).json()) as {
      bricks: Array<{ id: string; forever: boolean }>;
    };
    expect(listAfter.bricks.find((b) => b.id === id)?.forever).toBe(true);

    const deact = await fetch(`${base}/api/admin/bricks/${id}/deactivate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'spam' }),
    });
    expect(deact.status).toBe(200);
    expect(store.getBrick(id)?.status).toBe('deactivated');

    const del = await fetch(`${base}/api/admin/bricks/${id}/delete`, { method: 'POST' });
    expect(del.status).toBe(200);
    expect(store.getBrick(id)).toBeNull();
  });
});
