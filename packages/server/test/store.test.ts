import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BRICK_ACTIVE_DAYS, PENDING_PAYMENT_TTL_MS } from '../src/config';
import { Store } from '../src/store';

const DAY = 86_400_000;

function makeBrick(store: Store, id = 'a'.repeat(32), now = 1000): void {
  store.createBrick({
    id,
    size: 2,
    displayName: 'Test Brick',
    linkUrl: 'https://example.com',
    tilePaths: [`bricks/${id}/tile-0.png`, `bricks/${id}/tile-1.png`],
    fullPath: `bricks/${id}/full.png`,
    originalPath: `bricks/${id}/original.png`,
    now,
  });
}

describe('brick store', () => {
  it('creates bricks as pending_payment and activates them on payment', () => {
    const store = new Store(':memory:');
    makeBrick(store);
    expect(store.getBrick('a'.repeat(32))?.status).toBe('pending_payment');

    expect(store.markPaid('a'.repeat(32), 777, 2000)).toBe(true);
    const brick = store.getBrick('a'.repeat(32))!;
    expect(brick.status).toBe('active');
    expect(brick.orderId).toBe(777);
    expect(brick.expiresAt).toBe(2000 + BRICK_ACTIVE_DAYS * DAY);

    // Paying twice does nothing (idempotent at the store level too).
    expect(store.markPaid('a'.repeat(32), 888, 3000)).toBe(false);
    expect(store.getBrick('a'.repeat(32))!.orderId).toBe(777);
  });

  it('expires unpaid bricks after 24h', () => {
    const store = new Store(':memory:');
    makeBrick(store, 'b'.repeat(32), 0);
    store.expireSweep(PENDING_PAYMENT_TTL_MS - 1);
    expect(store.getBrick('b'.repeat(32))?.status).toBe('pending_payment');
    store.expireSweep(PENDING_PAYMENT_TTL_MS + 1);
    expect(store.getBrick('b'.repeat(32))?.status).toBe('expired');
    // An expired brick can no longer be activated by a late webhook.
    expect(store.markPaid('b'.repeat(32), 1, PENDING_PAYMENT_TTL_MS + 2)).toBe(false);
  });

  it('expires active bricks after their 30 days', () => {
    const store = new Store(':memory:');
    makeBrick(store, 'c'.repeat(32), 0);
    store.markPaid('c'.repeat(32), 1, 0);
    expect(store.activeBricks(BRICK_ACTIVE_DAYS * DAY - 1)).toHaveLength(1);
    expect(store.activeBricks(BRICK_ACTIVE_DAYS * DAY + 1)).toHaveLength(0);
    expect(store.getBrick('c'.repeat(32))?.status).toBe('expired');
  });

  it('finds bricks by order id and attaches license keys', () => {
    const store = new Store(':memory:');
    makeBrick(store, 'd'.repeat(32));
    store.markPaid('d'.repeat(32), 555, 2000);
    expect(store.findByOrderId(555)?.id).toBe('d'.repeat(32));
    store.attachLicenseKey(555, 9001);
    expect(store.getBrick('d'.repeat(32))?.licenseKeyId).toBe(9001);
  });

  it('batches stats updates', () => {
    const store = new Store(':memory:');
    makeBrick(store, 'e'.repeat(32));
    store.markPaid('e'.repeat(32), 1, 0);
    store.addStats(
      new Map([['e'.repeat(32), { appearances: 1, tilesDestroyed: 2, fullyDestroyed: 1 }]]),
    );
    store.addStats(
      new Map([['e'.repeat(32), { appearances: 1, tilesDestroyed: 1, fullyDestroyed: 0 }]]),
    );
    const brick = store.getBrick('e'.repeat(32))!;
    expect(brick.appearances).toBe(2);
    expect(brick.tilesDestroyed).toBe(3);
    expect(brick.fullyDestroyed).toBe(1);
  });

  it('batches view/click engagement and rolls it into the aggregate', () => {
    const store = new Store(':memory:');
    const id = 'e'.repeat(32);
    makeBrick(store, id);
    store.markPaid(id, 1, 0);
    store.addEngagement(new Map([[id, { views: 3, clicks: 1 }]]));
    store.addEngagement(new Map([[id, { views: 2, clicks: 2 }]]));
    store.addEngagement(new Map([['z'.repeat(32), { views: 9, clicks: 9 }]])); // unknown id: no-op
    const brick = store.getBrick(id)!;
    expect(brick.views).toBe(5);
    expect(brick.clicks).toBe(3);
    const agg = store.brickStats();
    expect(agg.views).toBe(5);
    expect(agg.clicks).toBe(3);
  });

  it('deactivation removes a brick from rotation', () => {
    const store = new Store(':memory:');
    makeBrick(store, 'f'.repeat(32));
    store.markPaid('f'.repeat(32), 1, 0);
    expect(store.activeBricks(100)).toHaveLength(1);
    expect(store.deactivate('f'.repeat(32), 'policy violation')).toBe(true);
    expect(store.activeBricks(100)).toHaveLength(0);
    expect(store.getBrick('f'.repeat(32))?.rejectReason).toBe('policy violation');
  });

  it('records webhook idempotency keys exactly once', () => {
    const store = new Store(':memory:');
    expect(store.markWebhookProcessed('order_created:1', 0)).toBe(true);
    expect(store.markWebhookProcessed('order_created:1', 1)).toBe(false);
    expect(store.markWebhookProcessed('order_created:2', 2)).toBe(true);
  });

  it('tracks skin activations per license key', () => {
    const store = new Store(':memory:');
    store.recordSkinActivation(42, 'inst-a', 0);
    store.recordSkinActivation(42, 'inst-a', 1); // duplicate ignored
    store.recordSkinActivation(42, 'inst-b', 2);
    expect(store.skinActivationCount(42)).toBe(2);
  });
});

describe('migrations', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bm-migrate-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('adopts a pre-drizzle database (hand-written schema) without data loss', () => {
    // A production DB as the old raw-SQL Store created it, with live data.
    const dbPath = path.join(dir, 'legacy.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE IF NOT EXISTS bricks (
        id TEXT PRIMARY KEY, size INTEGER NOT NULL, status TEXT NOT NULL,
        display_name TEXT NOT NULL, link_url TEXT, tile_paths TEXT NOT NULL,
        full_path TEXT NOT NULL, original_path TEXT NOT NULL, order_id INTEGER,
        license_key_id INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER,
        reject_reason TEXT, appearances INTEGER NOT NULL DEFAULT 0,
        tiles_destroyed INTEGER NOT NULL DEFAULT 0, fully_destroyed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_bricks_status ON bricks(status);
      CREATE INDEX IF NOT EXISTS idx_bricks_order ON bricks(order_id);
      CREATE TABLE IF NOT EXISTS processed_webhooks (
        event_key TEXT PRIMARY KEY, processed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skin_activations (
        license_key_id INTEGER NOT NULL, instance_id TEXT NOT NULL,
        activated_at INTEGER NOT NULL, PRIMARY KEY (license_key_id, instance_id)
      );
      INSERT INTO bricks (id, size, status, display_name, link_url, tile_paths, full_path, original_path, created_at, expires_at)
      VALUES ('${'a'.repeat(32)}', 2, 'active', 'Legacy Brick', NULL, '["t0.png","t1.png"]', 'full.png', 'orig.png', 1000, 9999999999999);
    `);
    legacy.close();

    // Opening with the drizzle-backed Store applies the baseline migration
    // (idempotent CREATEs) plus the new auth tables, and keeps existing rows.
    const store = new Store(dbPath);
    const brick = store.getBrick('a'.repeat(32))!;
    expect(brick.status).toBe('active');
    expect(brick.tilePaths).toEqual(['t0.png', 't1.png']);
    const account = store.createAccount('b'.repeat(32), 2000);
    expect(store.attachCredentials(account.id, 'adopt@example.com', 'hash')).toBe('ok');
    store.close();

    // Reopening replays nothing (the migration journal remembers).
    const reopened = new Store(dbPath);
    expect(reopened.getBrick('a'.repeat(32))?.displayName).toBe('Legacy Brick');
    expect(reopened.accountByEmail('adopt@example.com')?.id).toBe(account.id);
    reopened.close();
  });
});
