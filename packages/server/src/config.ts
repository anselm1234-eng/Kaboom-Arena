import path from 'node:path';

export interface LsVariantIds {
  brick1x1: string | null;
  brick2x1: string | null;
  brick3x1: string | null;
  skin: string | null;
}

export interface SuddenDeathEnvConfig {
  afterMs?: number;
  intervalMs?: number;
  warningMs?: number;
}

export interface AfkEnvConfig {
  warningMs?: number;
  kickMs?: number;
}

export interface PublicStartEnvConfig {
  readyTimeoutMs?: number;
  botFillTarget?: number;
}

export interface Config {
  port: number;
  clientDist: string;
  /** Sudden-death overrides; unset fields fall back to shared defaults. */
  suddenDeath: SuddenDeathEnvConfig;
  /** AFK-kick overrides; unset fields fall back to shared defaults. */
  afk: AfkEnvConfig;
  /** Public ready-start overrides; unset fields fall back to shared defaults. */
  publicStart: PublicStartEnvConfig;
  lsApiKey: string | null;
  lsWebhookSecret: string | null;
  lsStoreId: string | null;
  lsVariants: LsVariantIds;
  dbPath: string;
  uploadsDir: string;
  /** Resend API key for transactional email; unset = log emails to console. */
  resendApiKey: string | null;
  emailFrom: string;
  /** Canonical public origin for links in emails (falls back to the request host). */
  appOrigin: string | null;
}

function env(name: string): string | null {
  const v = process.env[name];
  return v !== undefined && v !== '' ? v : null;
}

function envMs(name: string): number | undefined {
  const v = env(name);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function loadConfig(): Config {
  const sdAfterMs = envMs('SUDDEN_DEATH_AFTER_MS');
  const crushIntervalMs = envMs('CRUSH_INTERVAL_MS');
  const crushWarningMs = envMs('CRUSH_WARNING_MS');
  const afkWarningMs = envMs('AFK_WARNING_MS');
  const afkKickMs = envMs('AFK_KICK_MS');
  const readyTimeoutMs = envMs('READY_TIMEOUT_MS');
  const botFillTarget = envMs('BOT_FILL_TARGET');
  return {
    port: Number(process.env.PORT ?? 8080),
    clientDist: process.env.CLIENT_DIST ?? path.resolve(process.cwd(), '../client/dist'),
    suddenDeath: {
      ...(sdAfterMs !== undefined ? { afterMs: sdAfterMs } : {}),
      ...(crushIntervalMs !== undefined ? { intervalMs: crushIntervalMs } : {}),
      ...(crushWarningMs !== undefined ? { warningMs: crushWarningMs } : {}),
    },
    afk: {
      ...(afkWarningMs !== undefined ? { warningMs: afkWarningMs } : {}),
      ...(afkKickMs !== undefined ? { kickMs: afkKickMs } : {}),
    },
    publicStart: {
      ...(readyTimeoutMs !== undefined ? { readyTimeoutMs } : {}),
      ...(botFillTarget !== undefined ? { botFillTarget } : {}),
    },
    lsApiKey: env('LEMONSQUEEZY_API_KEY'),
    lsWebhookSecret: env('LEMONSQUEEZY_WEBHOOK_SECRET'),
    lsStoreId: env('LS_STORE_ID'),
    lsVariants: {
      brick1x1: env('LS_VARIANT_ID_BRICK_1X1'),
      brick2x1: env('LS_VARIANT_ID_BRICK_2X1'),
      brick3x1: env('LS_VARIANT_ID_BRICK_3X1'),
      skin: env('LS_VARIANT_ID_SKIN'),
    },
    dbPath: process.env.DB_PATH ?? path.resolve(process.cwd(), 'data/blastmates.db'),
    uploadsDir: process.env.UPLOADS_DIR ?? path.resolve(process.cwd(), 'data/uploads'),
    resendApiKey: env('RESEND_API_KEY'),
    emailFrom: env('EMAIL_FROM') ?? 'Blastmates <onboarding@resend.dev>',
    appOrigin: env('APP_ORIGIN'),
  };
}

export function variantForSize(variants: LsVariantIds, size: 1 | 2 | 3): string | null {
  return size === 1 ? variants.brick1x1 : size === 2 ? variants.brick2x1 : variants.brick3x1;
}

/** Brick pricing/terms shown in the UI and enforced in flows. */
export const BRICK_PRICES_EUR: Record<1 | 2 | 3, number> = { 1: 5, 2: 8, 3: 12 };
export const BRICK_ACTIVE_DAYS = 30;
export const PENDING_PAYMENT_TTL_MS = 24 * 60 * 60 * 1000;
