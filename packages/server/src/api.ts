import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { writeFile, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { BRICK_ACTIVE_DAYS, BRICK_PRICES_EUR, variantForSize, type Config } from './config';
import { randomToken } from './ids';
import {
  BRICK_VARIANTS,
  ImageError,
  MAX_UPLOAD_BYTES,
  processBrickImage,
  renderAllVariants,
} from './images';
import { LinkError, fetchSourceImages } from './linkpreview';
import { RateLimiter, clientIp } from './ratelimit';
import { LsError, type LsClient } from './ls';
import type { BrickCache } from './bricks';
import type { AccountRow, BrickRow, BrickSize, Store } from './store';
import type { RoomManager } from './manager';
import { handleLsWebhook } from './webhooks';

export interface ApiDeps {
  store: Store;
  cache: BrickCache;
  ls: LsClient;
  cfg: Config;
  manager: RoomManager;
  /** Resolve the signed-in account behind a request (admin zone gate). */
  accountForRequest: (req: IncomingMessage) => AccountRow | null;
}

// --- Helpers ---

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

/** Read and parse a small JSON request body; null on missing/invalid JSON. */
async function parseJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req, 16_384);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}


export function publicOrigin(req: IncomingMessage, cfg: Config): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  const host = req.headers.host ?? `localhost:${cfg.port}`;
  return `${proto}://${host}`;
}

function brickPublicInfo(b: BrickRow, now: number): Record<string, unknown> {
  return {
    id: b.id,
    size: b.size,
    status: b.status,
    displayName: b.displayName,
    linkUrl: b.linkUrl,
    imageUrl: `/uploads/${b.fullPath}`,
    tileUrls: b.tilePaths.map((p) => `/uploads/${p}`),
    forever: b.status === 'active' && b.expiresAt === null,
    daysLeft:
      b.status === 'active' && b.expiresAt !== null
        ? Math.max(0, Math.ceil((b.expiresAt - now) / 86_400_000))
        : 0,
    stats: {
      appearances: b.appearances,
      tilesDestroyed: b.tilesDestroyed,
      fullyDestroyed: b.fullyDestroyed,
      views: b.views,
      clicks: b.clicks,
    },
  };
}

const VALID_SIZES: BrickSize[] = [1, 2, 3];

function parseSize(raw: string | null): BrickSize | null {
  const n = Number(raw);
  return VALID_SIZES.includes(n as BrickSize) ? (n as BrickSize) : null;
}

function sanitizeLinkUrl(raw: unknown): string | null | 'invalid' {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 200) return 'invalid';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'invalid';
    return url.toString();
  } catch {
    return 'invalid';
  }
}

/** Resolve a license key to its brick via the LS license API. */
async function brickByLicenseKey(
  deps: ApiDeps,
  key: string,
): Promise<{ brick: BrickRow } | { error: string; status: number }> {
  let result;
  try {
    result = await deps.ls.validateLicense(key);
  } catch (err) {
    if (err instanceof LsError) {
      return { error: 'License service unreachable, try again later', status: 503 };
    }
    throw err;
  }
  if (!result.valid) return { error: result.error ?? 'Invalid license key', status: 404 };
  if (deps.cfg.lsStoreId !== null && String(result.storeId) !== deps.cfg.lsStoreId) {
    return { error: 'License key belongs to a different store', status: 404 };
  }
  const brick =
    (result.orderId !== null ? deps.store.findByOrderId(result.orderId) : null) ??
    (result.licenseKeyId !== null
      ? deps.store.listBricks().find((b) => b.licenseKeyId === result.licenseKeyId) ?? null
      : null);
  if (!brick) return { error: 'No brick found for this license key', status: 404 };
  return { brick };
}

async function saveProcessedImages(
  dir: string,
  relDir: string,
  original: Buffer,
  originalType: string,
  processed: { tiles: Buffer[]; full: Buffer },
): Promise<{ tilePaths: string[]; fullPath: string; originalPath: string }> {
  mkdirSync(dir, { recursive: true });
  const originalPath = `${relDir}/original.${originalType}`;
  const fullPath = `${relDir}/full.png`;
  await writeFile(path.join(dir, `original.${originalType}`), original);
  await writeFile(path.join(dir, 'full.png'), processed.full);
  const tilePaths: string[] = [];
  for (let i = 0; i < processed.tiles.length; i++) {
    const tile = processed.tiles[i];
    if (!tile) continue;
    await writeFile(path.join(dir, `tile-${i}.png`), tile);
    tilePaths.push(`${relDir}/tile-${i}.png`);
  }
  return { tilePaths, fullPath, originalPath };
}

/**
 * A "studio draft" lives under previews/<uploadId>/ and holds one or more
 * candidate SOURCE images (src-N.png) plus, once rendered, a folder of styled
 * variants per source (v-<source>-<variantKey>/). Choosing one and creating
 * the brick promotes just that variant folder into bricks/<brickId>.
 */
const SOURCE_RE = /^([0-9]|1[0-5])$/;
const VARIANT_KEYS = new Set(BRICK_VARIANTS.map((v) => v.key));

function draftDir(uploadsDir: string, uploadId: string): string {
  return path.join(uploadsDir, 'previews', uploadId);
}

function variantRel(uploadId: string, source: number, key: string): string {
  return `previews/${uploadId}/v-${source}-${key}`;
}

/**
 * Move a chosen variant folder into place as the brick's asset folder. Returns
 * null when the draft/variant has expired or never existed.
 */
async function promoteVariant(
  uploadsDir: string,
  uploadId: string,
  source: number,
  key: string,
  size: BrickSize,
): Promise<{ brickId: string; relDir: string; tilePaths: string[]; fullPath: string; originalPath: string } | null> {
  const fromRel = variantRel(uploadId, source, key);
  const fromDir = path.join(uploadsDir, fromRel);
  if (!existsSync(path.join(fromDir, 'full.png'))) return null;
  const brickId = randomToken();
  const relDir = `bricks/${brickId}`;
  const brickDir = path.join(uploadsDir, relDir);
  mkdirSync(path.dirname(brickDir), { recursive: true });
  await rename(fromDir, brickDir);
  const tilePaths: string[] = [];
  for (let i = 0; i < size; i++) tilePaths.push(`${relDir}/tile-${i}.png`);
  return {
    brickId,
    relDir,
    tilePaths,
    fullPath: `${relDir}/full.png`,
    originalPath: `${relDir}/original.png`,
  };
}

/** Drop preview folders older than an hour. */
function cleanStalePreviews(previewRoot: string, now: number): void {
  if (!existsSync(previewRoot)) return;
  for (const entry of readdirSync(previewRoot)) {
    const p = path.join(previewRoot, entry);
    try {
      if (now - statSync(p).mtimeMs > 3_600_000) rmSync(p, { recursive: true, force: true });
    } catch {
      // already gone
    }
  }
}

// --- API ---

export function createApi(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => boolean {
  const { store, cache, ls, cfg, manager } = deps;
  const uploadLimiter = new RateLimiter(10, 3_600_000); // 10 uploads/h/ip
  // Rendering is re-run many times in one studio session (per source, size and
  // variant preview), so it gets its own roomier budget rather than sharing the
  // strict upload cap.
  const renderLimiter = new RateLimiter(60, 3_600_000); // 60 renders/h/ip
  const webhookLimiter = new RateLimiter(120, 60_000);
  const apiLimiter = new RateLimiter(60, 60_000);

  mkdirSync(cfg.uploadsDir, { recursive: true });

  // --- Brick studio: source -> render variants -> create ---

  /** Start a fresh draft folder (GCing stale ones first); returns its id. */
  function freshDraft(): string {
    cleanStalePreviews(path.join(cfg.uploadsDir, 'previews'), Date.now());
    const uploadId = randomToken();
    mkdirSync(draftDir(cfg.uploadsDir, uploadId), { recursive: true });
    return uploadId;
  }

  interface SourceOut {
    i: number;
    kind: string;
    label: string;
    url: string;
  }

  /** Persist candidate source PNGs into a draft and describe them for the UI. */
  async function writeSources(
    uploadId: string,
    items: Array<{ png: Buffer; kind: string; label: string }>,
  ): Promise<SourceOut[]> {
    const dir = draftDir(cfg.uploadsDir, uploadId);
    const out: SourceOut[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      await writeFile(path.join(dir, `src-${i}.png`), item.png);
      out.push({ i, kind: item.kind, label: item.label, url: `/uploads/previews/${uploadId}/src-${i}.png` });
    }
    return out;
  }

  async function handleSourceUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!uploadLimiter.allow(clientIp(req), Date.now())) {
      json(res, 429, { error: 'Too many uploads, slow down' });
      return;
    }
    const body = await readBody(req, MAX_UPLOAD_BYTES);
    if (!body || body.length === 0) {
      json(res, 413, { error: 'Image missing or larger than 2MB' });
      return;
    }
    const uploadId = freshDraft();
    const sources = await writeSources(uploadId, [{ png: body, kind: 'upload', label: 'YOUR IMAGE' }]);
    json(res, 200, { uploadId, sources });
  }

  async function handleSourceUrl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!uploadLimiter.allow(clientIp(req), Date.now())) {
      json(res, 429, { error: 'Too many requests, slow down' });
      return;
    }
    const body = await parseJson(req);
    const target = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!target) {
      json(res, 400, { error: 'A URL is required' });
      return;
    }
    let images;
    try {
      images = await fetchSourceImages(target);
    } catch (err) {
      if (err instanceof LinkError) {
        json(res, 400, { error: err.message });
        return;
      }
      throw err;
    }
    const uploadId = freshDraft();
    const sources = await writeSources(
      uploadId,
      images.map((im) => ({ png: im.png, kind: im.kind, label: im.label })),
    );
    json(res, 200, { uploadId, sources });
  }

  async function handleRender(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!renderLimiter.allow(clientIp(req), Date.now())) {
      json(res, 429, { error: 'Too many requests, slow down' });
      return;
    }
    const body = await parseJson(req);
    const uploadId = typeof body?.uploadId === 'string' ? body.uploadId : '';
    const source = Number(body?.source);
    const size = parseSize(String(body?.size));
    if (!/^[a-f0-9]{32}$/.test(uploadId) || !SOURCE_RE.test(String(source)) || !size) {
      json(res, 400, { error: 'uploadId, source and size are required' });
      return;
    }
    const srcFile = path.join(draftDir(cfg.uploadsDir, uploadId), `src-${source}.png`);
    if (!existsSync(srcFile)) {
      json(res, 404, { error: 'Source not found or expired — start over' });
      return;
    }
    const srcBuf = readFileSync(srcFile);
    const rendered = await renderAllVariants(srcBuf, size);
    if (rendered.length === 0) {
      json(res, 400, { error: 'Could not render this image — try another one' });
      return;
    }
    const variants: Array<{ key: string; label: string; hint: string; url: string; fullUrl: string }> = [];
    for (const v of rendered) {
      const rel = variantRel(uploadId, source, v.key);
      const dir = path.join(cfg.uploadsDir, rel);
      mkdirSync(dir, { recursive: true });
      await writeFile(path.join(dir, 'full.png'), v.full);
      await writeFile(path.join(dir, 'framed.png'), v.framed);
      await copyFile(srcFile, path.join(dir, 'original.png'));
      for (let i = 0; i < v.tiles.length; i++) await writeFile(path.join(dir, `tile-${i}.png`), v.tiles[i]!);
      variants.push({
        key: v.key,
        label: v.label,
        hint: v.hint,
        url: `/uploads/${rel}/framed.png`,
        fullUrl: `/uploads/${rel}/full.png`,
      });
    }
    json(res, 200, { uploadId, source, size, priceEur: BRICK_PRICES_EUR[size], variants });
  }

  interface CreateInput {
    uploadId: string;
    source: number;
    variant: string;
    size: BrickSize;
    displayName: string;
    linkUrl: string | null;
  }

  /** Shared parse + validation for both the paid and admin create endpoints. */
  async function parseCreateInput(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<CreateInput | null> {
    const body = await parseJson(req);
    const uploadId = typeof body?.uploadId === 'string' ? body.uploadId : '';
    const source = Number(body?.source);
    const variant = typeof body?.variant === 'string' ? body.variant : '';
    const size = parseSize(String(body?.size));
    const displayName =
      typeof body?.displayName === 'string' ? body.displayName.trim().slice(0, 24) : '';
    const linkUrl = sanitizeLinkUrl(body?.linkUrl);
    if (
      !/^[a-f0-9]{32}$/.test(uploadId) ||
      !SOURCE_RE.test(String(source)) ||
      !VARIANT_KEYS.has(variant) ||
      !size ||
      displayName.length === 0
    ) {
      json(res, 400, { error: 'uploadId, source, variant, size and a display name are required' });
      return null;
    }
    if (linkUrl === 'invalid') {
      json(res, 400, { error: 'linkUrl must be a valid http(s) URL' });
      return null;
    }
    return { uploadId, source, variant, size, displayName, linkUrl };
  }

  async function handleCreateBrick(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!apiLimiter.allow(clientIp(req), Date.now())) {
      json(res, 429, { error: 'Too many requests' });
      return;
    }
    const input = await parseCreateInput(req, res);
    if (!input) return;
    const promoted = await promoteVariant(
      cfg.uploadsDir,
      input.uploadId,
      input.source,
      input.variant,
      input.size,
    );
    if (!promoted) {
      json(res, 404, { error: 'Selection not found or expired — start over' });
      return;
    }
    const variantId = variantForSize(cfg.lsVariants, input.size);
    const { brickId } = promoted;
    store.createBrick({
      id: brickId,
      size: input.size,
      displayName: input.displayName,
      linkUrl: input.linkUrl,
      tilePaths: promoted.tilePaths,
      fullPath: promoted.fullPath,
      originalPath: promoted.originalPath,
      now: Date.now(),
    });

    // Without LS configured (dev / self-host) the brick is created but
    // stays pending_payment; only the webhook can activate it.
    if (!cfg.lsStoreId || !variantId) {
      json(res, 200, {
        brickId,
        checkoutUrl: null,
        note: 'Checkout is not configured on this server',
      });
      return;
    }
    let checkoutUrl: string;
    try {
      checkoutUrl = await ls.createCheckout({
        storeId: cfg.lsStoreId,
        variantId,
        customData: { brick_id: brickId },
        redirectUrl: `${publicOrigin(req, cfg)}/manage?brick=${brickId}`,
      });
    } catch (err) {
      if (err instanceof LsError) {
        json(res, 503, { error: `Could not create checkout: ${err.message}` });
        return;
      }
      throw err;
    }
    json(res, 200, { brickId, checkoutUrl });
  }

  async function handleManageValidate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!apiLimiter.allow(clientIp(req), Date.now())) {
      json(res, 429, { error: 'Too many requests' });
      return;
    }
    const body = await readBody(req, 4096);
    let key: string;
    try {
      const parsed = JSON.parse(body?.toString('utf8') ?? '') as { key?: unknown };
      key = typeof parsed.key === 'string' ? parsed.key.trim() : '';
    } catch {
      key = '';
    }
    if (!key || key.length > 64) {
      json(res, 400, { error: 'License key required' });
      return;
    }
    const found = await brickByLicenseKey(deps, key);
    if ('error' in found) {
      json(res, found.status, { error: found.error });
      return;
    }
    json(res, 200, { brick: brickPublicInfo(found.brick, Date.now()) });
  }

  async function handleManageReplace(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!uploadLimiter.allow(clientIp(req), Date.now())) {
      json(res, 429, { error: 'Too many uploads, slow down' });
      return;
    }
    const key = (req.headers['x-license-key'] as string | undefined)?.trim() ?? '';
    if (!key) {
      json(res, 400, { error: 'License key required' });
      return;
    }
    const found = await brickByLicenseKey(deps, key);
    if ('error' in found) {
      json(res, found.status, { error: found.error });
      return;
    }
    const brick = found.brick;
    if (brick.status !== 'active') {
      json(res, 409, { error: `Brick is ${brick.status}; only active bricks can be updated` });
      return;
    }
    const body = await readBody(req, MAX_UPLOAD_BYTES);
    if (!body || body.length === 0) {
      json(res, 413, { error: 'Image missing or larger than 2MB' });
      return;
    }
    let processed;
    try {
      processed = await processBrickImage(body, brick.size);
    } catch (err) {
      if (err instanceof ImageError) {
        json(res, 400, { error: err.message });
        return;
      }
      throw err;
    }
    const relDir = `bricks/${brick.id}`;
    const type = body[0] === 0x89 ? 'png' : 'jpg';
    const saved = await saveProcessedImages(
      path.join(cfg.uploadsDir, relDir),
      relDir,
      body,
      type,
      processed,
    );
    store.replaceImage(brick.id, saved.tilePaths, saved.fullPath, saved.originalPath);
    cache.invalidate();
    const updated = store.getBrick(brick.id);
    json(res, 200, { brick: updated ? brickPublicInfo(updated, Date.now()) : null });
  }

  function handleWall(res: ServerResponse): void {
    const now = Date.now();
    const bricks = store.activeBricks(now).map((b) => ({
      id: b.id,
      displayName: b.displayName,
      linkUrl: b.linkUrl,
      imageUrl: `/uploads/${b.fullPath}`,
      size: b.size,
      tilesDestroyed: b.tilesDestroyed,
    }));
    json(res, 200, { bricks });
  }

  /** The admin zone is gated by the signed-in account's is_admin flag. */
  function requireAdmin(req: IncomingMessage, res: ServerResponse): AccountRow | null {
    const account = deps.accountForRequest(req);
    if (!account) {
      json(res, 401, { error: 'Sign in to use the admin zone' });
      return null;
    }
    if (!account.isAdmin) {
      json(res, 403, { error: 'Admins only' });
      return null;
    }
    return account;
  }

  function adminSummary(res: ServerResponse): void {
    const now = Date.now();
    store.expireSweep(now);
    json(res, 200, {
      accounts: store.accountStats(),
      bricks: store.brickStats(),
      live: manager.liveStats(),
      online: manager.onlinePlayers(),
    });
  }

  async function handleAdminCreateBrick(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Same studio flow as buyers (source -> render -> create), but free + live.
    const input = await parseCreateInput(req, res);
    if (!input) return;
    const promoted = await promoteVariant(
      cfg.uploadsDir,
      input.uploadId,
      input.source,
      input.variant,
      input.size,
    );
    if (!promoted) {
      json(res, 404, { error: 'Selection not found or expired — start over' });
      return;
    }
    const brick = store.createActiveBrick({
      id: promoted.brickId,
      size: input.size,
      displayName: input.displayName,
      linkUrl: input.linkUrl,
      tilePaths: promoted.tilePaths,
      fullPath: promoted.fullPath,
      originalPath: promoted.originalPath,
      now: Date.now(),
    });
    cache.invalidate();
    json(res, 200, { brick: brickPublicInfo(brick, Date.now()) });
  }

  async function handleAdminEditBrick(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    const brick = store.getBrick(id);
    if (!brick) {
      json(res, 404, { error: 'Brick not found' });
      return;
    }
    const body = await readBody(req, 16_384);
    let parsed: { displayName?: unknown; linkUrl?: unknown };
    try {
      parsed = JSON.parse(body?.toString('utf8') ?? '') as typeof parsed;
    } catch {
      json(res, 400, { error: 'Bad JSON' });
      return;
    }
    const displayName =
      typeof parsed.displayName === 'string' ? parsed.displayName.trim().slice(0, 24) : brick.displayName;
    if (displayName.length === 0) {
      json(res, 400, { error: 'displayName cannot be empty' });
      return;
    }
    const linkUrl = sanitizeLinkUrl(parsed.linkUrl);
    if (linkUrl === 'invalid') {
      json(res, 400, { error: 'linkUrl must be a valid http(s) URL' });
      return;
    }
    store.updateBrickMeta(id, displayName, linkUrl);
    cache.invalidate();
    const updated = store.getBrick(id);
    json(res, 200, { brick: updated ? brickPublicInfo(updated, Date.now()) : null });
  }

  async function handleAdminReplaceImage(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    const brick = store.getBrick(id);
    if (!brick) {
      json(res, 404, { error: 'Brick not found' });
      return;
    }
    const body = await readBody(req, MAX_UPLOAD_BYTES);
    if (!body || body.length === 0) {
      json(res, 413, { error: 'Image missing or larger than 2MB' });
      return;
    }
    let processed;
    try {
      processed = await processBrickImage(body, brick.size);
    } catch (err) {
      if (err instanceof ImageError) {
        json(res, 400, { error: err.message });
        return;
      }
      throw err;
    }
    const relDir = `bricks/${brick.id}`;
    const type = body[0] === 0x89 ? 'png' : 'jpg';
    const saved = await saveProcessedImages(
      path.join(cfg.uploadsDir, relDir),
      relDir,
      body,
      type,
      processed,
    );
    store.replaceImage(brick.id, saved.tilePaths, saved.fullPath, saved.originalPath);
    cache.invalidate();
    const updated = store.getBrick(brick.id);
    json(res, 200, { brick: updated ? brickPublicInfo(updated, Date.now()) : null });
  }

  function handleAdminDeleteBrick(res: ServerResponse, id: string): void {
    const deleted = store.deleteBrick(id);
    if (!deleted) {
      json(res, 404, { error: 'Brick not found' });
      return;
    }
    // Best-effort cleanup of the asset folder; a stale folder is harmless.
    const brickDir = path.join(cfg.uploadsDir, 'bricks', id);
    try {
      if (existsSync(brickDir) && brickDir.startsWith(cfg.uploadsDir)) {
        rmSync(brickDir, { recursive: true, force: true });
      }
    } catch {
      // leave the folder; the row is already gone
    }
    cache.invalidate();
    json(res, 200, { ok: true });
  }

  async function handleSkinRedeem(
    req: IncomingMessage,
    res: ServerResponse,
    mode: 'redeem' | 'validate',
  ): Promise<void> {
    if (!apiLimiter.allow(clientIp(req), Date.now())) {
      json(res, 429, { error: 'Too many requests' });
      return;
    }
    const body = await readBody(req, 4096);
    let key = '';
    let instance = '';
    try {
      const parsed = JSON.parse(body?.toString('utf8') ?? '') as {
        key?: unknown;
        instance?: unknown;
      };
      key = typeof parsed.key === 'string' ? parsed.key.trim() : '';
      instance = typeof parsed.instance === 'string' ? parsed.instance.slice(0, 64) : 'blastmates';
    } catch {
      // fall through to validation error
    }
    if (!key || key.length > 64) {
      json(res, 400, { error: 'License key required' });
      return;
    }
    let result;
    try {
      result =
        mode === 'redeem'
          ? await ls.activateLicense(key, instance || 'blastmates')
          : await ls.validateLicense(key);
    } catch (err) {
      if (err instanceof LsError) {
        // Fail open: an unreachable license server never locks paying users out.
        json(res, 200, { ok: true, unverified: true });
        return;
      }
      throw err;
    }
    if (!result.valid) {
      json(res, 403, { error: result.error ?? 'Invalid or used-up license key' });
      return;
    }
    if (
      cfg.lsVariants.skin !== null &&
      result.variantId !== null &&
      String(result.variantId) !== cfg.lsVariants.skin
    ) {
      json(res, 403, { error: 'This key is not a skin pack key' });
      return;
    }
    if (mode === 'redeem' && result.licenseKeyId !== null) {
      store.recordSkinActivation(result.licenseKeyId, result.instanceId ?? instance, Date.now());
    }
    json(res, 200, { ok: true });
  }

  return (req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/';

    // Static uploaded images.
    if (urlPath.startsWith('/uploads/') && req.method === 'GET') {
      const rel = path.normalize(urlPath.slice('/uploads/'.length));
      const filePath = path.join(cfg.uploadsDir, rel);
      if (!filePath.startsWith(cfg.uploadsDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end();
        return true;
      }
      res.writeHead(200, {
        'content-type': filePath.endsWith('.png') ? 'image/png' : 'image/jpeg',
        'cache-control': 'public, max-age=300',
      });
      res.end(readFileSync(filePath));
      return true;
    }

    if (!urlPath.startsWith('/api/')) return false;

    const route = `${req.method} ${urlPath}`;
    const handled = (p: Promise<void>): true => {
      p.catch((err) => {
        console.error('api error', route, err);
        if (!res.headersSent) json(res, 500, { error: 'Internal error' });
      });
      return true;
    };

    if (route === 'POST /api/bricks/source') return handled(handleSourceUpload(req, res));
    if (route === 'POST /api/bricks/source-url') return handled(handleSourceUrl(req, res));
    if (route === 'POST /api/bricks/render') return handled(handleRender(req, res));
    if (route === 'POST /api/bricks') return handled(handleCreateBrick(req, res));
    if (route === 'POST /api/manage/validate') return handled(handleManageValidate(req, res));
    if (route === 'POST /api/manage/replace') return handled(handleManageReplace(req, res));
    if (route === 'GET /api/wall') {
      handleWall(res);
      return true;
    }
    if (route === 'POST /api/skins/redeem') return handled(handleSkinRedeem(req, res, 'redeem'));
    if (route === 'POST /api/skins/validate')
      return handled(handleSkinRedeem(req, res, 'validate'));

    if (route === 'POST /api/webhooks/lemonsqueezy') {
      if (!webhookLimiter.allow(clientIp(req), Date.now())) {
        json(res, 429, { error: 'rate limited' });
        return true;
      }
      return handled(
        readBody(req, 1_048_576).then((raw) => {
          if (!raw) {
            json(res, 413, { error: 'body too large' });
            return;
          }
          const result = handleLsWebhook(
            store,
            raw,
            req.headers['x-signature'] as string | undefined,
            cfg.lsWebhookSecret,
            Date.now(),
          );
          if (result.status === 200) cache.invalidate();
          res.writeHead(result.status, { 'content-type': 'text/plain' });
          res.end(result.body);
        }),
      );
    }

    if (urlPath.startsWith('/api/admin/')) {
      if (!apiLimiter.allow(clientIp(req), Date.now())) {
        json(res, 429, { error: 'rate limited' });
        return true;
      }
      if (!requireAdmin(req, res)) return true;

      if (route === 'GET /api/admin/summary') {
        adminSummary(res);
        return true;
      }
      if (route === 'GET /api/admin/bricks') {
        const now = Date.now();
        store.expireSweep(now);
        json(res, 200, { bricks: store.listBricks().map((b) => brickPublicInfo(b, now)) });
        return true;
      }
      if (route === 'POST /api/admin/bricks') return handled(handleAdminCreateBrick(req, res));

      const editM = /^POST \/api\/admin\/bricks\/([a-f0-9]{32})\/edit$/.exec(route);
      if (editM?.[1]) return handled(handleAdminEditBrick(req, res, editM[1]));

      const replaceM = /^POST \/api\/admin\/bricks\/([a-f0-9]{32})\/replace$/.exec(route);
      if (replaceM?.[1]) return handled(handleAdminReplaceImage(req, res, replaceM[1]));

      const deleteM = /^POST \/api\/admin\/bricks\/([a-f0-9]{32})\/delete$/.exec(route);
      if (deleteM?.[1]) {
        handleAdminDeleteBrick(res, deleteM[1]);
        return true;
      }

      const foreverM = /^POST \/api\/admin\/bricks\/([a-f0-9]{32})\/forever$/.exec(route);
      if (foreverM?.[1]) {
        const id = foreverM[1];
        return handled(
          readBody(req, 4096).then((raw) => {
            let forever = true;
            try {
              const parsed = JSON.parse(raw?.toString('utf8') || '{}') as { forever?: unknown };
              if (typeof parsed.forever === 'boolean') forever = parsed.forever;
            } catch {
              // default to making it forever
            }
            const ok = store.setForever(id, forever, Date.now());
            cache.invalidate();
            json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Brick not found' });
          }),
        );
      }

      const deactM = /^POST \/api\/admin\/bricks\/([a-f0-9]{32})\/deactivate$/.exec(route);
      if (deactM?.[1]) {
        const id = deactM[1];
        return handled(
          readBody(req, 4096).then((raw) => {
            let reason: string | null = null;
            try {
              const parsed = JSON.parse(raw?.toString('utf8') || '{}') as { reason?: unknown };
              if (typeof parsed.reason === 'string') reason = parsed.reason.slice(0, 200);
            } catch {
              // no reason given
            }
            const ok = store.deactivate(id, reason);
            cache.invalidate();
            json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Brick not found' });
          }),
        );
      }
      json(res, 404, { error: 'Unknown admin route' });
      return true;
    }

    json(res, 404, { error: 'Unknown API route' });
    return true;
  };
}

export { BRICK_ACTIVE_DAYS };
