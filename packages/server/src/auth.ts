import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { publicOrigin, readBody } from './api';
import type { Config } from './config';
import type { Mailer } from './email';
import { randomToken } from './ids';
import { hashPassword, verifyPassword } from './passwords';
import { RateLimiter, clientIp } from './ratelimit';
import type { AccountRow, Store } from './store';

/**
 * Email/password auth on top of anonymous-first accounts.
 *
 * Everyone plays instantly: the client creates an anonymous account (one
 * lightweight row + an httpOnly session cookie) right before the first join,
 * with no UI in the way. Signing up later upgrades that same account row, so
 * progression earned as a guest carries over. Security posture:
 *  - passwords hashed with scrypt (see passwords.ts)
 *  - session + email tokens are 256-bit random, stored only as SHA-256 hashes
 *  - cookies are httpOnly + SameSite=Lax (+ Secure behind https)
 *  - mutating endpoints check the Origin header against the host (CSRF)
 *  - login/registration are rate-limited per IP (and login per email)
 */

export interface AuthDeps {
  store: Store;
  cfg: Config;
  mailer: Mailer;
}

export interface Auth {
  handle(req: IncomingMessage, res: ServerResponse): boolean;
  /** Resolve the account behind a request (HTTP or WebSocket upgrade). */
  accountIdForRequest(req: IncomingMessage): string | null;
  /** Full account row behind a request, or null when not signed in. */
  accountForRequest(req: IncomingMessage): AccountRow | null;
}

const SESSION_COOKIE = 'bm_session';
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
/** Sliding expiry: bump a session's deadline at most ~once a day. */
const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[a-f0-9]{64}$/;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('hex');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(303, { location: to, 'cache-control': 'no-store' });
  res.end();
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function accountJson(a: AccountRow): {
  id: string;
  email: string | null;
  verified: boolean;
  admin: boolean;
  nickname: string | null;
} {
  return {
    id: a.id,
    email: a.email,
    verified: a.emailVerified,
    admin: a.isAdmin,
    nickname: a.nickname,
  };
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req, 8192);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizedEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

function validPassword(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return raw.length >= PASSWORD_MIN && raw.length <= PASSWORD_MAX ? raw : null;
}

// --- Email content ---

function verifyEmail(origin: string, token: string): { subject: string; text: string; html: string } {
  const url = `${origin}/api/auth/verify?token=${token}`;
  return {
    subject: 'Verify your email for Blastmates',
    text:
      `Confirm your email for Blastmates by opening this link:\n\n${url}\n\n` +
      `The link is valid for 24 hours. If you didn't create a Blastmates account, you can ignore this email.\n`,
    html:
      `<p>Confirm your email for <strong>Blastmates</strong>:</p>` +
      `<p><a href="${url}">Verify my email</a></p>` +
      `<p>The link is valid for 24 hours. If you didn't create a Blastmates account, you can ignore this email.</p>`,
  };
}

function resetEmail(origin: string, token: string): { subject: string; text: string; html: string } {
  const url = `${origin}/reset?token=${token}`;
  return {
    subject: 'Reset your Blastmates password',
    text:
      `Someone (hopefully you) asked to reset the password for this Blastmates account.\n\n` +
      `Set a new password here:\n\n${url}\n\n` +
      `The link is valid for 30 minutes. If you didn't ask for this, you can ignore this email.\n`,
    html:
      `<p>Someone (hopefully you) asked to reset the password for this <strong>Blastmates</strong> account.</p>` +
      `<p><a href="${url}">Set a new password</a></p>` +
      `<p>The link is valid for 30 minutes. If you didn't ask for this, you can ignore this email.</p>`,
  };
}

// --- Service ---

export function createAuth(deps: AuthDeps): Auth {
  const { store, cfg, mailer } = deps;

  const guestLimiter = new RateLimiter(30, 600_000); // account creation per IP
  const registerLimiter = new RateLimiter(10, 3_600_000);
  const loginIpLimiter = new RateLimiter(10, 900_000); // failures only
  const loginEmailLimiter = new RateLimiter(5, 900_000); // failures only
  const forgotLimiter = new RateLimiter(5, 3_600_000);
  const forgotEmailLimiter = new RateLimiter(3, 3_600_000);
  const tokenLimiter = new RateLimiter(30, 3_600_000); // verify/reset/resend

  // Verifying against this when the email is unknown keeps login timing flat,
  // so response time doesn't leak which emails have accounts.
  const dummyHash = hashPassword(newToken());

  function isSecure(req: IncomingMessage): boolean {
    const proto = req.headers['x-forwarded-proto'];
    if (typeof proto === 'string' && proto.split(',')[0]?.trim() === 'https') return true;
    return cfg.appOrigin?.startsWith('https://') ?? false;
  }

  function setSessionCookie(req: IncomingMessage, res: ServerResponse, token: string, maxAgeMs: number): void {
    const parts = [
      `${SESSION_COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ];
    if (isSecure(req)) parts.push('Secure');
    res.setHeader('set-cookie', parts.join('; '));
  }

  /**
   * Browsers send Origin on all cross-origin and most same-origin POSTs; when
   * present it must match our host. Combined with SameSite=Lax cookies this
   * blocks cross-site request forgery.
   */
  function sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '') return true;
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    if (host === req.headers.host) return true;
    if (cfg.appOrigin) {
      try {
        return new URL(cfg.appOrigin).host === host;
      } catch {
        return false;
      }
    }
    return false;
  }

  function requestSession(req: IncomingMessage): { tokenHash: string; accountId: string } | null {
    const token = cookieValue(req, SESSION_COOKIE);
    if (!token || !TOKEN_RE.test(token)) return null;
    const now = Date.now();
    const tokenHash = sha256(token);
    const session = store.authSession(tokenHash, now);
    if (!session) return null;
    if (session.expiresAt - now < SESSION_TTL_MS - SESSION_REFRESH_AFTER_MS) {
      store.extendAuthSession(tokenHash, now + SESSION_TTL_MS);
      store.touchAccount(session.accountId, now);
    }
    return { tokenHash, accountId: session.accountId };
  }

  function accountForRequest(req: IncomingMessage): AccountRow | null {
    const session = requestSession(req);
    return session ? store.getAccount(session.accountId) : null;
  }

  /** Drop the current session row (if any) and issue a fresh cookie for the account. */
  function rotateSession(req: IncomingMessage, res: ServerResponse, accountId: string): void {
    const current = requestSession(req);
    if (current) store.deleteAuthSession(current.tokenHash);
    const token = newToken();
    const now = Date.now();
    store.createAuthSession(sha256(token), accountId, now, now + SESSION_TTL_MS);
    setSessionCookie(req, res, token, SESSION_TTL_MS);
  }

  function linkOrigin(req: IncomingMessage): string {
    return cfg.appOrigin ?? publicOrigin(req, cfg);
  }

  async function sendVerification(req: IncomingMessage, accountId: string, email: string): Promise<void> {
    const token = newToken();
    const now = Date.now();
    store.createEmailToken(sha256(token), accountId, 'verify', email, now, now + VERIFY_TTL_MS);
    const msg = verifyEmail(linkOrigin(req), token);
    await mailer.send({ to: email, ...msg });
  }

  // --- Handlers ---

  async function handleGuest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req)) {
      json(res, 403, { error: 'Bad origin' });
      return;
    }
    const existing = accountForRequest(req);
    if (existing) {
      json(res, 200, { account: accountJson(existing) });
      return;
    }
    if (!guestLimiter.allow(clientIp(req), Date.now())) {
      json(res, 429, { error: 'Too many requests' });
      return;
    }
    const account = store.createAccount(randomToken(), Date.now());
    rotateSession(req, res, account.id);
    json(res, 200, { account: accountJson(account) });
  }

  function handleMe(req: IncomingMessage, res: ServerResponse): void {
    const account = accountForRequest(req);
    json(res, 200, { account: account ? accountJson(account) : null });
  }

  async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req)) {
      json(res, 403, { error: 'Bad origin' });
      return;
    }
    if (!registerLimiter.allow(clientIp(req), Date.now())) {
      json(res, 429, { error: 'Too many sign-up attempts - try again later' });
      return;
    }
    const body = await parseJsonBody(req);
    const email = normalizedEmail(body?.email);
    const password = validPassword(body?.password);
    if (!email || !password) {
      json(res, 400, {
        error: `A valid email and a password of ${PASSWORD_MIN}+ characters are required`,
      });
      return;
    }
    let account = accountForRequest(req);
    if (account && account.email !== null) {
      json(res, 409, { error: 'This browser is already signed in to an account' });
      return;
    }
    const passwordHash = await hashPassword(password);
    // Upgrade the existing anonymous account so guest progress carries over;
    // brand-new visitors get a fresh account on the spot.
    if (!account) account = store.createAccount(randomToken(), Date.now());
    const attached = store.attachCredentials(account.id, email, passwordHash);
    if (attached === 'email_taken') {
      json(res, 409, { error: 'This email is already registered - sign in instead' });
      return;
    }
    if (attached !== 'ok') {
      json(res, 409, { error: 'Could not create the account - try again' });
      return;
    }
    rotateSession(req, res, account.id);
    await sendVerification(req, account.id, email);
    const updated = store.getAccount(account.id);
    json(res, 200, { account: updated ? accountJson(updated) : null });
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req)) {
      json(res, 403, { error: 'Bad origin' });
      return;
    }
    const body = await parseJsonBody(req);
    const email = normalizedEmail(body?.email);
    const password = typeof body?.password === 'string' ? body.password : null;
    if (!email || !password) {
      json(res, 400, { error: 'Email and password are required' });
      return;
    }
    const ip = clientIp(req);
    const now = Date.now();
    if (loginIpLimiter.blocked(ip, now) || loginEmailLimiter.blocked(email, now)) {
      json(res, 429, { error: 'Too many attempts - try again in a few minutes' });
      return;
    }
    const account = store.accountByEmail(email);
    const ok =
      account?.passwordHash != null
        ? await verifyPassword(password, account.passwordHash)
        : await verifyPassword(password, await dummyHash);
    if (!account || !ok) {
      // Only failures consume rate-limit slots; correct logins never throttle.
      loginIpLimiter.allow(ip, now);
      loginEmailLimiter.allow(email, now);
      json(res, 401, { error: 'Wrong email or password' });
      return;
    }
    rotateSession(req, res, account.id);
    store.touchAccount(account.id, Date.now());
    json(res, 200, { account: accountJson(account) });
  }

  function handleLogout(req: IncomingMessage, res: ServerResponse): void {
    if (!sameOrigin(req)) {
      json(res, 403, { error: 'Bad origin' });
      return;
    }
    const session = requestSession(req);
    if (session) store.deleteAuthSession(session.tokenHash);
    setSessionCookie(req, res, '', 0);
    json(res, 200, { ok: true });
  }

  function handleVerify(req: IncomingMessage, res: ServerResponse): void {
    if (!tokenLimiter.allow(clientIp(req), Date.now())) {
      json(res, 429, { error: 'Too many requests' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const token = url.searchParams.get('token') ?? '';
    let ok = false;
    if (TOKEN_RE.test(token)) {
      const consumed = store.consumeEmailToken(sha256(token), 'verify', Date.now());
      if (consumed) ok = store.markEmailVerified(consumed.accountId, consumed.email);
    }
    redirect(res, `/account?verified=${ok ? '1' : '0'}`);
  }

  async function handleResend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req)) {
      json(res, 403, { error: 'Bad origin' });
      return;
    }
    const account = accountForRequest(req);
    if (!account?.email) {
      json(res, 400, { error: 'No email on this account' });
      return;
    }
    if (account.emailVerified) {
      json(res, 200, { ok: true });
      return;
    }
    if (!tokenLimiter.allow(`resend:${account.id}`, Date.now())) {
      json(res, 429, { error: 'Too many requests - check your inbox' });
      return;
    }
    await sendVerification(req, account.id, account.email);
    json(res, 200, { ok: true });
  }

  async function handleForgot(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req)) {
      json(res, 403, { error: 'Bad origin' });
      return;
    }
    const now = Date.now();
    if (!forgotLimiter.allow(clientIp(req), now)) {
      json(res, 429, { error: 'Too many requests - try again later' });
      return;
    }
    const body = await parseJsonBody(req);
    const email = normalizedEmail(body?.email);
    if (!email) {
      json(res, 400, { error: 'A valid email is required' });
      return;
    }
    const account = store.accountByEmail(email);
    if (account && forgotEmailLimiter.allow(email, now)) {
      const token = newToken();
      store.createEmailToken(sha256(token), account.id, 'reset', email, now, now + RESET_TTL_MS);
      const msg = resetEmail(linkOrigin(req), token);
      await mailer.send({ to: email, ...msg });
    }
    // Identical response either way: no account enumeration through this route.
    json(res, 200, { ok: true });
  }

  async function handleReset(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameOrigin(req)) {
      json(res, 403, { error: 'Bad origin' });
      return;
    }
    if (!tokenLimiter.allow(clientIp(req), Date.now())) {
      json(res, 429, { error: 'Too many requests' });
      return;
    }
    const body = await parseJsonBody(req);
    const token = typeof body?.token === 'string' ? body.token : '';
    const password = validPassword(body?.password);
    if (!password) {
      json(res, 400, { error: `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters` });
      return;
    }
    const consumed = TOKEN_RE.test(token)
      ? store.consumeEmailToken(sha256(token), 'reset', Date.now())
      : null;
    if (!consumed) {
      json(res, 400, { error: 'This reset link is invalid or has expired - request a new one' });
      return;
    }
    store.setPassword(consumed.accountId, await hashPassword(password));
    // Following the reset link proves mailbox ownership.
    store.markEmailVerified(consumed.accountId, consumed.email);
    store.deleteAccountSessions(consumed.accountId); // log out everywhere
    rotateSession(req, res, consumed.accountId);
    const account = store.getAccount(consumed.accountId);
    json(res, 200, { account: account ? accountJson(account) : null });
  }

  function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
    if (!urlPath.startsWith('/api/auth/')) return false;
    const route = `${req.method} ${urlPath}`;
    const handled = (p: Promise<void>): true => {
      p.catch((err) => {
        console.error('auth api error', route, err);
        if (!res.headersSent) json(res, 500, { error: 'Internal error' });
      });
      return true;
    };

    if (route === 'POST /api/auth/guest') return handled(handleGuest(req, res));
    if (route === 'GET /api/auth/me') {
      handleMe(req, res);
      return true;
    }
    if (route === 'POST /api/auth/register') return handled(handleRegister(req, res));
    if (route === 'POST /api/auth/login') return handled(handleLogin(req, res));
    if (route === 'POST /api/auth/logout') {
      handleLogout(req, res);
      return true;
    }
    if (route === 'GET /api/auth/verify') {
      handleVerify(req, res);
      return true;
    }
    if (route === 'POST /api/auth/resend') return handled(handleResend(req, res));
    if (route === 'POST /api/auth/forgot') return handled(handleForgot(req, res));
    if (route === 'POST /api/auth/reset') return handled(handleReset(req, res));

    json(res, 404, { error: 'Unknown auth route' });
    return true;
  }

  return {
    handle,
    accountIdForRequest(req: IncomingMessage): string | null {
      return requestSession(req)?.accountId ?? null;
    },
    accountForRequest(req: IncomingMessage): AccountRow | null {
      return accountForRequest(req);
    },
  };
}
