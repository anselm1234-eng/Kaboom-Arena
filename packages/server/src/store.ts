import Database from 'better-sqlite3';
import { and, asc, count, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { BRICK_ACTIVE_DAYS, PENDING_PAYMENT_TTL_MS } from './config';
import { hashPassword } from './passwords';
import {
  accounts,
  authSessions,
  bricks,
  emailTokens,
  processedWebhooks,
  skinActivations,
  type EmailTokenPurpose,
} from './db/schema';

// The table definitions in db/schema.ts are the single source of truth; row
// types are inferred from them, and SQL migrations are generated from them
// with `pnpm db:generate` (applied automatically in the constructor below).
export type { BrickSize, BrickStatus, EmailTokenPurpose } from './db/schema';
export type BrickRow = typeof bricks.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;

export interface BrickStats {
  appearances: number;
  tilesDestroyed: number;
  fullyDestroyed: number;
}

/** Client-reported engagement signals, accumulated per brick before a flush. */
export interface BrickEngagement {
  views: number;
  clicks: number;
}

/**
 * Accounts whose admin flag is re-asserted on every boot. The 0001 migration
 * grants it too, but a fresh dev DB (or an account that signs up only after
 * the migration ran) would miss out, so we reapply it idempotently here.
 */
export const SEED_ADMIN_EMAILS = ['martin.boksa@gmail.com'];

/** Where the versioned .sql migrations live (next to the server at runtime). */
export function defaultMigrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'drizzle');
}

export class Store {
  private readonly sqlite: Database.Database;
  private readonly db: BetterSQLite3Database;

  constructor(dbPath: string, migrationsFolder = defaultMigrationsDir()) {
    if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
    this.sqlite = new Database(dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    this.db = drizzle(this.sqlite);
    migrate(this.db, { migrationsFolder });
    for (const email of SEED_ADMIN_EMAILS) this.grantAdminByEmail(email);
  }

  close(): void {
    this.sqlite.close();
  }

  /**
   * Insert a ready-to-use account (email + password) if that email is free.
   * Used only by the dev seed (see seedDevAccounts); a no-op in production.
   */
  ensureSeedUser(input: {
    id: string;
    email: string;
    passwordHash: string;
    nickname: string;
    isAdmin?: boolean;
    now: number;
  }): boolean {
    const res = this.db
      .insert(accounts)
      .values({
        id: input.id,
        email: input.email.toLowerCase(),
        passwordHash: input.passwordHash,
        emailVerified: true,
        isAdmin: input.isAdmin ?? false,
        nickname: input.nickname,
        createdAt: input.now,
        lastSeenAt: input.now,
      })
      .onConflictDoNothing()
      .run();
    return res.changes > 0;
  }

  /** Idempotently flag an existing account (by email) as an admin. */
  grantAdminByEmail(email: string): boolean {
    const res = this.db
      .update(accounts)
      .set({ isAdmin: true })
      .where(eq(accounts.email, email.toLowerCase()))
      .run();
    return res.changes > 0;
  }

  // --- Bricks ---

  createBrick(input: {
    id: string;
    size: BrickRow['size'];
    displayName: string;
    linkUrl: string | null;
    tilePaths: string[];
    fullPath: string;
    originalPath: string;
    now: number;
  }): BrickRow {
    return this.db
      .insert(bricks)
      .values({
        id: input.id,
        size: input.size,
        status: 'pending_payment',
        displayName: input.displayName,
        linkUrl: input.linkUrl,
        tilePaths: input.tilePaths,
        fullPath: input.fullPath,
        originalPath: input.originalPath,
        createdAt: input.now,
      })
      .returning()
      .get();
  }

  /**
   * Admin-created brick: no payment, live immediately for BRICK_ACTIVE_DAYS.
   * Mirrors createBrick + markPaid in one step (orderId stays null = free).
   */
  createActiveBrick(input: {
    id: string;
    size: BrickRow['size'];
    displayName: string;
    linkUrl: string | null;
    tilePaths: string[];
    fullPath: string;
    originalPath: string;
    now: number;
  }): BrickRow {
    return this.db
      .insert(bricks)
      .values({
        id: input.id,
        size: input.size,
        status: 'active',
        displayName: input.displayName,
        linkUrl: input.linkUrl,
        tilePaths: input.tilePaths,
        fullPath: input.fullPath,
        originalPath: input.originalPath,
        createdAt: input.now,
        expiresAt: input.now + BRICK_ACTIVE_DAYS * 24 * 60 * 60 * 1000,
      })
      .returning()
      .get();
  }

  getBrick(id: string): BrickRow | null {
    return this.db.select().from(bricks).where(eq(bricks.id, id)).get() ?? null;
  }

  /** Admin edit of the display fields (image is swapped via replaceImage). */
  updateBrickMeta(id: string, displayName: string, linkUrl: string | null): boolean {
    const res = this.db
      .update(bricks)
      .set({ displayName, linkUrl })
      .where(eq(bricks.id, id))
      .run();
    return res.changes > 0;
  }

  /** Remove a brick entirely; returns the deleted row so its files can be cleaned. */
  deleteBrick(id: string): BrickRow | null {
    return this.db.delete(bricks).where(eq(bricks.id, id)).returning().get() ?? null;
  }

  findByOrderId(orderId: number): BrickRow | null {
    return this.db.select().from(bricks).where(eq(bricks.orderId, orderId)).get() ?? null;
  }

  /** Payment confirmed by webhook: brick goes live for BRICK_ACTIVE_DAYS. */
  markPaid(id: string, orderId: number, now: number): boolean {
    const res = this.db
      .update(bricks)
      .set({ status: 'active', orderId, expiresAt: now + BRICK_ACTIVE_DAYS * 24 * 60 * 60 * 1000 })
      .where(and(eq(bricks.id, id), eq(bricks.status, 'pending_payment')))
      .run();
    return res.changes > 0;
  }

  attachLicenseKey(orderId: number, licenseKeyId: number): void {
    this.db.update(bricks).set({ licenseKeyId }).where(eq(bricks.orderId, orderId)).run();
  }

  replaceImage(id: string, tilePaths: string[], fullPath: string, originalPath: string): void {
    this.db.update(bricks).set({ tilePaths, fullPath, originalPath }).where(eq(bricks.id, id)).run();
  }

  deactivate(id: string, reason: string | null): boolean {
    const res = this.db
      .update(bricks)
      .set({ status: 'deactivated', rejectReason: reason })
      .where(eq(bricks.id, id))
      .run();
    return res.changes > 0;
  }

  /**
   * Admin "forever" toggle: a permanent brick is active with no expiry, so the
   * expireSweep never touches it (NULL expiresAt fails the `lt` comparison).
   * Turning it off restores a normal BRICK_ACTIVE_DAYS window from now; either
   * way the brick is (re)activated, so an expired brick can be brought back.
   */
  setForever(id: string, forever: boolean, now: number): boolean {
    const res = this.db
      .update(bricks)
      .set({
        status: 'active',
        expiresAt: forever ? null : now + BRICK_ACTIVE_DAYS * 24 * 60 * 60 * 1000,
      })
      .where(eq(bricks.id, id))
      .run();
    return res.changes > 0;
  }

  /** Expire unpaid bricks after 24h and active bricks past their 30 days. */
  expireSweep(now: number): void {
    this.db
      .update(bricks)
      .set({ status: 'expired' })
      .where(and(eq(bricks.status, 'pending_payment'), lt(bricks.createdAt, now - PENDING_PAYMENT_TTL_MS)))
      .run();
    this.db
      .update(bricks)
      .set({ status: 'expired' })
      .where(and(eq(bricks.status, 'active'), lt(bricks.expiresAt, now)))
      .run();
  }

  activeBricks(now: number): BrickRow[] {
    this.expireSweep(now);
    return this.db
      .select()
      .from(bricks)
      .where(eq(bricks.status, 'active'))
      .orderBy(asc(bricks.createdAt))
      .all();
  }

  listBricks(): BrickRow[] {
    return this.db.select().from(bricks).orderBy(desc(bricks.createdAt)).limit(500).all();
  }

  /** Batched stats write, one transaction per round. */
  addStats(stats: Map<string, BrickStats>): void {
    this.db.transaction((tx) => {
      for (const [id, s] of stats) {
        tx.update(bricks)
          .set({
            appearances: sql`${bricks.appearances} + ${s.appearances}`,
            tilesDestroyed: sql`${bricks.tilesDestroyed} + ${s.tilesDestroyed}`,
            fullyDestroyed: sql`${bricks.fullyDestroyed} + ${s.fullyDestroyed}`,
          })
          .where(eq(bricks.id, id))
          .run();
      }
    });
  }

  /**
   * Batched engagement write (popup views + outbound clicks), one transaction
   * per flush. Updates target live bricks by id; unknown ids are silent no-ops.
   */
  addEngagement(events: Map<string, BrickEngagement>): void {
    if (events.size === 0) return;
    this.db.transaction((tx) => {
      for (const [id, e] of events) {
        tx.update(bricks)
          .set({
            views: sql`${bricks.views} + ${e.views}`,
            clicks: sql`${bricks.clicks} + ${e.clicks}`,
          })
          .where(eq(bricks.id, id))
          .run();
      }
    });
  }

  // --- Webhook idempotency ---

  /** Returns true the first time an event key is seen, false on replays. */
  markWebhookProcessed(eventKey: string, now: number): boolean {
    const res = this.db
      .insert(processedWebhooks)
      .values({ eventKey, processedAt: now })
      .onConflictDoNothing()
      .run();
    return res.changes > 0;
  }

  // --- Skin activations (bookkeeping only; LS enforces the limit) ---

  recordSkinActivation(licenseKeyId: number, instanceId: string, now: number): void {
    this.db
      .insert(skinActivations)
      .values({ licenseKeyId, instanceId, activatedAt: now })
      .onConflictDoNothing()
      .run();
  }

  skinActivationCount(licenseKeyId: number): number {
    return (
      this.db
        .select({ n: count() })
        .from(skinActivations)
        .where(eq(skinActivations.licenseKeyId, licenseKeyId))
        .get()?.n ?? 0
    );
  }

  // --- Accounts (anonymous-first; sign-up upgrades the row in place) ---

  createAccount(id: string, now: number): AccountRow {
    return this.db.insert(accounts).values({ id, createdAt: now, lastSeenAt: now }).returning().get();
  }

  getAccount(id: string): AccountRow | null {
    return this.db.select().from(accounts).where(eq(accounts.id, id)).get() ?? null;
  }

  accountByEmail(email: string): AccountRow | null {
    return this.db.select().from(accounts).where(eq(accounts.email, email)).get() ?? null;
  }

  /**
   * Upgrade an anonymous account with credentials. The WHERE email IS NULL
   * guard makes concurrent upgrades of the same account lose cleanly.
   */
  attachCredentials(
    id: string,
    email: string,
    passwordHash: string,
  ): 'ok' | 'email_taken' | 'unavailable' {
    try {
      const res = this.db
        .update(accounts)
        .set({ email, passwordHash, emailVerified: false })
        .where(and(eq(accounts.id, id), isNull(accounts.email)))
        .run();
      return res.changes > 0 ? 'ok' : 'unavailable';
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE')) return 'email_taken';
      throw err;
    }
  }

  setPassword(id: string, passwordHash: string): void {
    this.db.update(accounts).set({ passwordHash }).where(eq(accounts.id, id)).run();
  }

  /** Mark verified only if the account still carries the email the token was for. */
  markEmailVerified(id: string, email: string): boolean {
    const res = this.db
      .update(accounts)
      .set({ emailVerified: true })
      .where(and(eq(accounts.id, id), eq(accounts.email, email)))
      .run();
    return res.changes > 0;
  }

  touchAccount(id: string, now: number): void {
    this.db.update(accounts).set({ lastSeenAt: now }).where(eq(accounts.id, id)).run();
  }

  /** Remember the nickname the account last played under (leaderboards later). */
  setAccountNickname(id: string, nickname: string, now: number): void {
    this.db
      .update(accounts)
      .set({ nickname, lastSeenAt: now })
      .where(eq(accounts.id, id))
      .run();
  }

  // --- Admin zone aggregates ---

  /** Headline account counts for the admin dashboard. */
  accountStats(): { total: number; registered: number; verified: number; admins: number } {
    const row = this.db
      .select({
        total: count(),
        registered: sql<number>`sum(case when ${accounts.email} is not null then 1 else 0 end)`,
        verified: sql<number>`sum(case when ${accounts.emailVerified} then 1 else 0 end)`,
        admins: sql<number>`sum(case when ${accounts.isAdmin} then 1 else 0 end)`,
      })
      .from(accounts)
      .get();
    return {
      total: row?.total ?? 0,
      registered: Number(row?.registered ?? 0),
      verified: Number(row?.verified ?? 0),
      admins: Number(row?.admins ?? 0),
    };
  }

  /** Brick counts per status plus the lifetime in-game tallies. */
  brickStats(): {
    byStatus: Record<string, number>;
    total: number;
    appearances: number;
    tilesDestroyed: number;
    fullyDestroyed: number;
    views: number;
    clicks: number;
  } {
    const rows = this.db
      .select({ status: bricks.status, n: count() })
      .from(bricks)
      .groupBy(bricks.status)
      .all();
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byStatus[r.status] = r.n;
      total += r.n;
    }
    const totals = this.db
      .select({
        appearances: sql<number>`coalesce(sum(${bricks.appearances}), 0)`,
        tilesDestroyed: sql<number>`coalesce(sum(${bricks.tilesDestroyed}), 0)`,
        fullyDestroyed: sql<number>`coalesce(sum(${bricks.fullyDestroyed}), 0)`,
        views: sql<number>`coalesce(sum(${bricks.views}), 0)`,
        clicks: sql<number>`coalesce(sum(${bricks.clicks}), 0)`,
      })
      .from(bricks)
      .get();
    return {
      byStatus,
      total,
      appearances: Number(totals?.appearances ?? 0),
      tilesDestroyed: Number(totals?.tilesDestroyed ?? 0),
      fullyDestroyed: Number(totals?.fullyDestroyed ?? 0),
      views: Number(totals?.views ?? 0),
      clicks: Number(totals?.clicks ?? 0),
    };
  }

  // --- Auth sessions (long-lived browser sessions; tokens stored hashed) ---

  createAuthSession(tokenHash: string, accountId: string, now: number, expiresAt: number): void {
    this.db.insert(authSessions).values({ tokenHash, accountId, createdAt: now, expiresAt }).run();
  }

  authSession(tokenHash: string, now: number): { accountId: string; expiresAt: number } | null {
    const r = this.db
      .select({ accountId: authSessions.accountId, expiresAt: authSessions.expiresAt })
      .from(authSessions)
      .where(eq(authSessions.tokenHash, tokenHash))
      .get();
    if (!r) return null;
    if (r.expiresAt <= now) {
      this.deleteAuthSession(tokenHash);
      return null;
    }
    return r;
  }

  extendAuthSession(tokenHash: string, expiresAt: number): void {
    this.db.update(authSessions).set({ expiresAt }).where(eq(authSessions.tokenHash, tokenHash)).run();
  }

  deleteAuthSession(tokenHash: string): void {
    this.db.delete(authSessions).where(eq(authSessions.tokenHash, tokenHash)).run();
  }

  /** Log the account out everywhere (password reset). */
  deleteAccountSessions(accountId: string): void {
    this.db.delete(authSessions).where(eq(authSessions.accountId, accountId)).run();
  }

  // --- Email tokens (verification / password reset; stored hashed, single use) ---

  /** One outstanding token per purpose: issuing a new one revokes the old. */
  createEmailToken(
    tokenHash: string,
    accountId: string,
    purpose: EmailTokenPurpose,
    email: string,
    now: number,
    expiresAt: number,
  ): void {
    this.db
      .delete(emailTokens)
      .where(and(eq(emailTokens.accountId, accountId), eq(emailTokens.purpose, purpose)))
      .run();
    this.db
      .insert(emailTokens)
      .values({ tokenHash, accountId, purpose, email, createdAt: now, expiresAt })
      .run();
  }

  consumeEmailToken(
    tokenHash: string,
    purpose: EmailTokenPurpose,
    now: number,
  ): { accountId: string; email: string } | null {
    const r = this.db
      .select({
        accountId: emailTokens.accountId,
        email: emailTokens.email,
        expiresAt: emailTokens.expiresAt,
      })
      .from(emailTokens)
      .where(and(eq(emailTokens.tokenHash, tokenHash), eq(emailTokens.purpose, purpose)))
      .get();
    if (!r) return null;
    this.db.delete(emailTokens).where(eq(emailTokens.tokenHash, tokenHash)).run();
    if (r.expiresAt <= now) return null;
    return { accountId: r.accountId, email: r.email };
  }
}

/**
 * Seed a convenient local test login. Dev only — the server bootstrap gates
 * this on NODE_ENV so production never gets a known-password account. Idempotent.
 */
export async function seedDevAccounts(store: Store): Promise<void> {
  if (store.accountByEmail('john@example.com')) return;
  const passwordHash = await hashPassword('password');
  store.ensureSeedUser({
    id: 'seed00000000000000000000000john01',
    email: 'john@example.com',
    passwordHash,
    nickname: 'John',
    isAdmin: true,
    now: Date.now(),
  });
}
