import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuth } from '../src/auth';
import type { Config } from '../src/config';
import type { EmailMessage, Mailer } from '../src/email';
import { hashPassword, verifyPassword } from '../src/passwords';
import { Store } from '../src/store';

function testCfg(): Config {
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
    uploadsDir: '',
    resendApiKey: null,
    emailFrom: 'Blastmates <test@example.com>',
    appOrigin: null,
  };
}

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt:16384:8:1:')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong horse', hash)).toBe(false);
  });

  it('produces unique salts and rejects malformed stored hashes', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('same', 'scrypt:999999999:8:1:AAAA:AAAA')).toBe(false);
  });
});

describe('account store', () => {
  it('upgrades an anonymous account in place and enforces email uniqueness', () => {
    const store = new Store(':memory:');
    const anon = store.createAccount('a'.repeat(32), 1000);
    expect(anon.email).toBeNull();

    expect(store.attachCredentials(anon.id, 'me@example.com', 'hash')).toBe('ok');
    const upgraded = store.getAccount(anon.id)!;
    expect(upgraded.email).toBe('me@example.com');
    expect(upgraded.emailVerified).toBe(false);
    expect(upgraded.createdAt).toBe(1000); // same row, progress carries over

    // A second upgrade of the same account loses cleanly.
    expect(store.attachCredentials(anon.id, 'other@example.com', 'hash')).toBe('unavailable');
    // Another account cannot take the same email.
    const other = store.createAccount('b'.repeat(32), 2000);
    expect(store.attachCredentials(other.id, 'me@example.com', 'hash')).toBe('email_taken');
    expect(store.accountByEmail('me@example.com')?.id).toBe(anon.id);
  });

  it('stores the last played nickname, latest rewrite winning', () => {
    const store = new Store(':memory:');
    const acc = store.createAccount('d'.repeat(32), 0);
    expect(acc.nickname).toBeNull();
    store.setAccountNickname(acc.id, 'BlastKing', 10);
    store.setAccountNickname(acc.id, 'CrateGoblin', 20);
    const updated = store.getAccount(acc.id)!;
    expect(updated.nickname).toBe('CrateGoblin');
    expect(updated.lastSeenAt).toBe(20);
    // Upgrading with credentials keeps the nickname (same row).
    store.attachCredentials(acc.id, 'nick@example.com', 'hash');
    expect(store.getAccount(acc.id)?.nickname).toBe('CrateGoblin');
  });

  it('only verifies the email the token was issued for', () => {
    const store = new Store(':memory:');
    const acc = store.createAccount('c'.repeat(32), 0);
    store.attachCredentials(acc.id, 'me@example.com', 'hash');
    expect(store.markEmailVerified(acc.id, 'stale@example.com')).toBe(false);
    expect(store.markEmailVerified(acc.id, 'me@example.com')).toBe(true);
    expect(store.getAccount(acc.id)?.emailVerified).toBe(true);
  });

  it('expires auth sessions and deletes them per account', () => {
    const store = new Store(':memory:');
    store.createAuthSession('t1', 'acc', 0, 100);
    expect(store.authSession('t1', 99)?.accountId).toBe('acc');
    expect(store.authSession('t1', 100)).toBeNull(); // expired (and pruned)
    store.createAuthSession('t2', 'acc', 0, 1000);
    store.createAuthSession('t3', 'acc', 0, 1000);
    store.deleteAccountSessions('acc');
    expect(store.authSession('t2', 1)).toBeNull();
    expect(store.authSession('t3', 1)).toBeNull();
  });

  it('email tokens are single-use, expiring, and replaced per purpose', () => {
    const store = new Store(':memory:');
    store.createEmailToken('h1', 'acc', 'verify', 'a@b.c', 0, 100);
    expect(store.consumeEmailToken('h1', 'reset', 1)).toBeNull(); // wrong purpose
    expect(store.consumeEmailToken('h1', 'verify', 1)).toEqual({
      accountId: 'acc',
      email: 'a@b.c',
    });
    expect(store.consumeEmailToken('h1', 'verify', 1)).toBeNull(); // single use

    store.createEmailToken('h2', 'acc', 'verify', 'a@b.c', 0, 100);
    store.createEmailToken('h3', 'acc', 'verify', 'a@b.c', 0, 100); // replaces h2
    expect(store.consumeEmailToken('h2', 'verify', 1)).toBeNull();
    expect(store.consumeEmailToken('h3', 'verify', 200)).toBeNull(); // expired
  });
});

// --- HTTP-level flows ---

interface AccountJson {
  id: string;
  email: string | null;
  verified: boolean;
}

class Client {
  private cookie: string | null = null;

  constructor(private readonly base: string) {}

  private capture(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const m = /^bm_session=([^;]*)/.exec(c);
      if (m) this.cookie = m[1] ? m[1] : null;
    }
  }

  async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: { account?: AccountJson | null; error?: string }; location: string | null }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(this.cookie ? { cookie: `bm_session=${this.cookie}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    this.capture(res);
    let data: { account?: AccountJson | null; error?: string } = {};
    try {
      data = (await res.json()) as typeof data;
    } catch {
      // redirects have no body
    }
    return { status: res.status, data, location: res.headers.get('location') };
  }
}

const servers: Server[] = [];

async function startAuthServer(): Promise<{
  client: () => Client;
  mails: EmailMessage[];
  store: Store;
  base: string;
}> {
  const store = new Store(':memory:');
  const mails: EmailMessage[] = [];
  const mailer: Mailer = {
    send: (m) => {
      mails.push(m);
      return Promise.resolve(true);
    },
  };
  const auth = createAuth({ store, cfg: testCfg(), mailer });
  const server = createServer((req, res) => {
    if (auth.handle(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return { client: () => new Client(base), mails, store, base };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function mailToken(mail: EmailMessage): string {
  const m = /token=([a-f0-9]{64})/.exec(mail.text);
  expect(m).not.toBeNull();
  return m![1]!;
}

describe('auth api', () => {
  it('guest -> register upgrade keeps the account id; verify link works once', async () => {
    const { client, mails } = await startAuthServer();
    const c = client();

    const guest = await c.call('POST', '/api/auth/guest');
    expect(guest.status).toBe(200);
    const guestId = guest.data.account!.id;
    expect(guest.data.account!.email).toBeNull();

    // Cookie session sticks: /me sees the same anonymous account.
    const me = await c.call('GET', '/api/auth/me');
    expect(me.data.account!.id).toBe(guestId);

    const reg = await c.call('POST', '/api/auth/register', {
      email: 'Player@Example.com ',
      password: 'super secret pw',
    });
    expect(reg.status).toBe(200);
    expect(reg.data.account!.id).toBe(guestId); // upgraded in place
    expect(reg.data.account!.email).toBe('player@example.com');
    expect(reg.data.account!.verified).toBe(false);

    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe('player@example.com');
    const token = mailToken(mails[0]!);

    const verify = await c.call('GET', `/api/auth/verify?token=${token}`);
    expect(verify.status).toBe(303);
    expect(verify.location).toBe('/account?verified=1');
    expect((await c.call('GET', '/api/auth/me')).data.account!.verified).toBe(true);

    // Tokens are single-use.
    const replay = await c.call('GET', `/api/auth/verify?token=${token}`);
    expect(replay.location).toBe('/account?verified=0');
  });

  it('logout and login round-trip; wrong passwords stay generic', async () => {
    const { client } = await startAuthServer();
    const c = client();
    await c.call('POST', '/api/auth/guest');
    const reg = await c.call('POST', '/api/auth/register', {
      email: 'p@example.com',
      password: 'super secret pw',
    });
    const id = reg.data.account!.id;

    await c.call('POST', '/api/auth/logout');
    expect((await c.call('GET', '/api/auth/me')).data.account).toBeNull();

    const bad = await c.call('POST', '/api/auth/login', {
      email: 'p@example.com',
      password: 'nope nope nope',
    });
    expect(bad.status).toBe(401);
    const unknown = await c.call('POST', '/api/auth/login', {
      email: 'ghost@example.com',
      password: 'whatever12345',
    });
    expect(unknown.status).toBe(401);
    expect(unknown.data.error).toBe(bad.data.error); // no account enumeration

    const good = await c.call('POST', '/api/auth/login', {
      email: 'p@example.com',
      password: 'super secret pw',
    });
    expect(good.status).toBe(200);
    expect(good.data.account!.id).toBe(id);
  });

  it('rejects duplicate emails and weak passwords', async () => {
    const { client } = await startAuthServer();
    const a = client();
    await a.call('POST', '/api/auth/register', {
      email: 'taken@example.com',
      password: 'super secret pw',
    });
    const b = client();
    const dup = await b.call('POST', '/api/auth/register', {
      email: 'taken@example.com',
      password: 'another secret',
    });
    expect(dup.status).toBe(409);
    const weak = await b.call('POST', '/api/auth/register', {
      email: 'new@example.com',
      password: 'short',
    });
    expect(weak.status).toBe(400);
  });

  it('password reset signs in, verifies the email and revokes old sessions', async () => {
    const { client, mails } = await startAuthServer();
    const c = client();
    await c.call('POST', '/api/auth/register', {
      email: 'r@example.com',
      password: 'original pass',
    });

    const other = client(); // a second signed-in browser
    await other.call('POST', '/api/auth/login', {
      email: 'r@example.com',
      password: 'original pass',
    });

    mails.length = 0;
    // Unknown emails get the same response and send nothing.
    const ghost = await c.call('POST', '/api/auth/forgot', { email: 'ghost@example.com' });
    expect(ghost.status).toBe(200);
    expect(mails).toHaveLength(0);

    await c.call('POST', '/api/auth/forgot', { email: 'r@example.com' });
    expect(mails).toHaveLength(1);
    const token = mailToken(mails[0]!);

    const reset = await c.call('POST', '/api/auth/reset', {
      token,
      password: 'brand new pass',
    });
    expect(reset.status).toBe(200);
    expect(reset.data.account!.verified).toBe(true); // reset link proves the mailbox

    // The other browser's session was revoked.
    expect((await other.call('GET', '/api/auth/me')).data.account).toBeNull();

    const oldPw = await c.call('POST', '/api/auth/login', {
      email: 'r@example.com',
      password: 'original pass',
    });
    expect(oldPw.status).toBe(401);
    const newPw = await c.call('POST', '/api/auth/login', {
      email: 'r@example.com',
      password: 'brand new pass',
    });
    expect(newPw.status).toBe(200);
  });

  it('throttles repeated login failures per email', async () => {
    const { client } = await startAuthServer();
    const c = client();
    await c.call('POST', '/api/auth/register', {
      email: 'limit@example.com',
      password: 'super secret pw',
    });
    for (let i = 0; i < 5; i++) {
      const res = await c.call('POST', '/api/auth/login', {
        email: 'limit@example.com',
        password: `wrong ${i} wrong`,
      });
      expect(res.status).toBe(401);
    }
    // Even the correct password is throttled now.
    const blocked = await c.call('POST', '/api/auth/login', {
      email: 'limit@example.com',
      password: 'super secret pw',
    });
    expect(blocked.status).toBe(429);
  });

  it('rejects cross-origin mutations but allows same-origin ones', async () => {
    const { base } = await startAuthServer();
    // A forged request from another site carries a mismatching Origin.
    const forged = await fetch(`${base}/api/auth/guest`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(forged.status).toBe(403);
    // The browser's own requests carry the matching Origin.
    const own = await fetch(`${base}/api/auth/guest`, {
      method: 'POST',
      headers: { origin: base },
    });
    expect(own.status).toBe(200);
  });
});
