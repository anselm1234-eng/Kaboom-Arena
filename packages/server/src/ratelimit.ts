import type { IncomingMessage } from 'node:http';

/** Simple fixed-window per-key rate limiter. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now: number): boolean {
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) this.hits.clear(); // memory guard
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }

  /** Whether the key is already over its limit, without consuming a slot. */
  blocked(key: string, now: number): boolean {
    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) return false;
    return entry.count >= this.limit;
  }
}

export function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0]?.trim() ?? 'unknown';
  return req.socket.remoteAddress ?? 'unknown';
}
