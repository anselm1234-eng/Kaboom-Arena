import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Single source of truth for the database. Row types are inferred from these
 * tables (see store.ts), and drizzle-kit diffs this file against the snapshot
 * in drizzle/meta to generate versioned SQL migrations:
 *
 *   pnpm db:generate   # after editing this file; commit the new drizzle/*.sql
 *
 * Migrations are applied automatically on server startup (Store constructor).
 */

export type BrickSize = 1 | 2 | 3;
export type BrickStatus = 'pending_payment' | 'active' | 'deactivated' | 'expired';
export type EmailTokenPurpose = 'verify' | 'reset';

export const bricks = sqliteTable(
  'bricks',
  {
    id: text('id').primaryKey(),
    size: integer('size').$type<BrickSize>().notNull(),
    status: text('status').$type<BrickStatus>().notNull(),
    displayName: text('display_name').notNull(),
    linkUrl: text('link_url'),
    /** Relative paths under the uploads dir, one 16x16 PNG per tile, left to right. */
    tilePaths: text('tile_paths', { mode: 'json' }).$type<string[]>().notNull(),
    fullPath: text('full_path').notNull(),
    originalPath: text('original_path').notNull(),
    orderId: integer('order_id'),
    licenseKeyId: integer('license_key_id'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at'),
    rejectReason: text('reject_reason'),
    appearances: integer('appearances').notNull().default(0),
    tilesDestroyed: integer('tiles_destroyed').notNull().default(0),
    fullyDestroyed: integer('fully_destroyed').notNull().default(0),
    /** Branded-card impressions: how many times a player saw the brand popup. */
    views: integer('views').notNull().default(0),
    /** Outbound clicks on the brand's "VISIT" link from the in-game popup. */
    clicks: integer('clicks').notNull().default(0),
  },
  (t) => [index('idx_bricks_status').on(t.status), index('idx_bricks_order').on(t.orderId)],
);

export const processedWebhooks = sqliteTable('processed_webhooks', {
  eventKey: text('event_key').primaryKey(),
  processedAt: integer('processed_at').notNull(),
});

export const skinActivations = sqliteTable(
  'skin_activations',
  {
    licenseKeyId: integer('license_key_id').notNull(),
    instanceId: text('instance_id').notNull(),
    activatedAt: integer('activated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.licenseKeyId, t.instanceId] })],
);

/**
 * A player account. Every player gets one (created lazily on first play) so
 * progression can accumulate from the very first match; anonymous accounts
 * have no email/password and are upgraded in place on sign-up, keeping the
 * same id (and with it any experience earned as a guest).
 */
export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  email: text('email').unique(),
  passwordHash: text('password_hash'),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  /** Staff flag: unlocks the admin zone (online players, stats, free brick CRUD). */
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  /** Last nickname played under; refreshed on every join (leaderboards later). */
  nickname: text('nickname'),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
});

/** Long-lived browser sessions; tokens are stored only as SHA-256 hashes. */
export const authSessions = sqliteTable(
  'auth_sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    accountId: text('account_id').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('idx_auth_sessions_account').on(t.accountId)],
);

/** Email verification / password-reset tokens; stored hashed, single use. */
export const emailTokens = sqliteTable(
  'email_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    accountId: text('account_id').notNull(),
    purpose: text('purpose').$type<EmailTokenPurpose>().notNull(),
    email: text('email').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('idx_email_tokens_account').on(t.accountId, t.purpose)],
);
