import { useSyncExternalStore } from 'react';

/**
 * Client side of the anonymous-first account system. Playing never requires
 * signing in: an anonymous account (httpOnly cookie session) is created
 * lazily right before the first join, and signing up later upgrades that
 * same account, so progress earned as a guest carries over.
 */

export interface Account {
  id: string;
  email: string | null;
  verified: boolean;
  /** Staff flag: unlocks the admin zone link on the landing screen. */
  admin: boolean;
  /** Last nickname played under (kept server-side for future leaderboards). */
  nickname: string | null;
}

interface AuthResponse {
  account?: Account | null;
  error?: string;
  ok?: boolean;
}

let account: Account | null = null;
/** True once /me has answered at least once (signed-out vs. still loading). */
let known = false;
/** Reset token parsed from a /reset email link, waiting for the form. */
let resetToken: string | null = null;
/** Outcome of a /api/auth/verify redirect, shown once on the account screen. */
let verifyNotice: 'ok' | 'failed' | null = null;

let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getVersion(): number {
  return version;
}

/** Re-render on account changes; read state via the exported getters. */
export function useAccount(): number {
  return useSyncExternalStore(subscribe, getVersion);
}

export function currentAccount(): Account | null {
  return account;
}

export function accountKnown(): boolean {
  return known;
}

export function setResetToken(token: string | null): void {
  resetToken = token;
}

export function pendingResetToken(): string | null {
  return resetToken;
}

export function setVerifyNotice(result: 'ok' | 'failed'): void {
  verifyNotice = result;
}

export function takeVerifyNotice(): 'ok' | 'failed' | null {
  const notice = verifyNotice;
  verifyNotice = null;
  return notice;
}

const NETWORK_ERROR = 'COULD NOT REACH THE SERVER';

async function call(
  path: string,
  body?: Record<string, unknown>,
  timeoutMs = 8000,
): Promise<{ status: number; data: AuthResponse }> {
  const res = await fetch(path, {
    signal: AbortSignal.timeout(timeoutMs),
    ...(body !== undefined
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  let data: AuthResponse = {};
  try {
    data = (await res.json()) as AuthResponse;
  } catch {
    // non-JSON error body; status is enough
  }
  return { status: res.status, data };
}

function applyAccount(next: Account | null): void {
  account = next;
  known = true;
  emit();
}

/** Run an auth call; returns null on success or an uppercase error message. */
async function authAction(
  path: string,
  body: Record<string, unknown>,
): Promise<string | null> {
  try {
    const { status, data } = await call(path, body);
    if (status === 200) {
      if (data.account !== undefined) applyAccount(data.account);
      return null;
    }
    return (data.error ?? 'SOMETHING WENT WRONG').toUpperCase();
  } catch {
    return NETWORK_ERROR;
  }
}

export async function refreshAccount(): Promise<void> {
  try {
    const { status, data } = await call('/api/auth/me');
    if (status === 200) applyAccount(data.account ?? null);
  } catch {
    // offline; leave state as-is
  }
}

/**
 * Make sure an account session exists before play. Never blocks the game:
 * failures (auth outage, offline) are swallowed and the join proceeds.
 */
export async function ensureAccount(): Promise<void> {
  if (account) return;
  try {
    const me = await call('/api/auth/me', undefined, 2500);
    if (me.status === 200 && me.data.account) {
      applyAccount(me.data.account);
      return;
    }
    const guest = await call('/api/auth/guest', {}, 2500);
    if (guest.status === 200 && guest.data.account) applyAccount(guest.data.account);
  } catch {
    // play on without an account
  }
}

export function registerAccount(email: string, password: string): Promise<string | null> {
  return authAction('/api/auth/register', { email, password });
}

export function login(email: string, password: string): Promise<string | null> {
  return authAction('/api/auth/login', { email, password });
}

export async function logout(): Promise<string | null> {
  const error = await authAction('/api/auth/logout', {});
  if (error === null) applyAccount(null);
  return error;
}

export function forgotPassword(email: string): Promise<string | null> {
  return authAction('/api/auth/forgot', { email });
}

export function resetPassword(token: string, password: string): Promise<string | null> {
  return authAction('/api/auth/reset', { token, password });
}

export function resendVerification(): Promise<string | null> {
  return authAction('/api/auth/resend', {});
}
