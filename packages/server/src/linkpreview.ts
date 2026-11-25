import { lookup } from 'node:dns/promises';
import sharp from 'sharp';

/**
 * "Paste a URL" brick sourcing: fetch a page and pull its favicon / app icon /
 * social-share image so the buyer can pick one instead of finding a file.
 *
 * Fetching arbitrary user-supplied URLs server-side is an SSRF risk, so every
 * hop is guarded: only http(s), every host is DNS-resolved and rejected if it
 * points at a private/loopback/link-local address, redirects are followed
 * manually (re-checking each hop), and both the HTML and each image are size-
 * and time-capped.
 */

export interface SourceImage {
  kind: string;
  label: string;
  /** Re-encoded PNG of the candidate, ready to feed the variant renderer. */
  png: Buffer;
  width: number;
  height: number;
}

export class LinkError extends Error {}

const HTML_MAX = 1_000_000;
const IMAGE_MAX = 2_000_000;
const FETCH_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 4;
const MAX_CANDIDATES = 10;
const MAX_RESULTS = 6;

function ipv4Private(addr: string): boolean {
  const p = addr.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

export function ipPrivate(addr: string): boolean {
  if (addr.includes('.') && !addr.includes(':')) return ipv4Private(addr);
  const a = addr.toLowerCase();
  if (a === '::1' || a === '::') return true;
  if (a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd')) return true;
  const mapped = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return ipv4Private(mapped[1]);
  return false;
}

async function assertPublicHost(host: string): Promise<void> {
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new LinkError('Could not resolve that host');
  }
  if (addrs.length === 0 || addrs.some((a) => ipPrivate(a.address))) {
    throw new LinkError('That URL is not allowed');
  }
}

interface FetchResult {
  finalUrl: string;
  contentType: string;
  body: Buffer;
}

async function safeFetch(rawUrl: string, maxBytes: number): Promise<FetchResult> {
  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new LinkError('Invalid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new LinkError('Only http and https URLs are supported');
    }
    await assertPublicHost(parsed.hostname);
    let res: Response;
    try {
      res = await fetch(parsed.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': 'BlastmatesBot/1.0 (+brick image fetcher)' },
      });
    } catch {
      throw new LinkError('Could not reach that URL');
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new LinkError('Broken redirect');
      url = new URL(loc, parsed).toString();
      continue;
    }
    if (!res.ok) throw new LinkError(`The site returned ${res.status}`);
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          size += value.length;
          if (size > maxBytes) {
            await reader.cancel();
            throw new LinkError('Response too large');
          }
          chunks.push(value);
        }
      }
    }
    return { finalUrl: parsed.toString(), contentType, body: Buffer.concat(chunks) };
  }
  throw new LinkError('Too many redirects');
}

/** Pull candidate image URLs (favicons, app icons, social images) out of HTML. */
export function extractCandidates(
  html: string,
  baseUrl: string,
): Array<{ kind: string; label: string; url: string }> {
  const out: Array<{ kind: string; label: string; url: string }> = [];
  const seen = new Set<string>();
  const add = (kind: string, label: string, href: string | undefined): void => {
    if (!href) return;
    let abs: string;
    try {
      abs = new URL(href.trim(), baseUrl).toString();
    } catch {
      return;
    }
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ kind, label, url: abs });
  };

  const attr = (tag: string, name: string): string | undefined =>
    new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)?.[1];

  // <meta property/name=... content=...>
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase();
    if (key === 'og:image' || key === 'og:image:url' || key === 'og:image:secure_url') {
      add('og', 'SOCIAL IMAGE', attr(tag, 'content'));
    } else if (key === 'twitter:image' || key === 'twitter:image:src') {
      add('twitter', 'TWITTER IMAGE', attr(tag, 'content'));
    }
  }
  // <link rel=... href=...>
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (attr(tag, 'rel') ?? '').toLowerCase();
    if (rel.includes('apple-touch-icon')) add('apple', 'APP ICON', attr(tag, 'href'));
    else if (rel.includes('mask-icon')) add('mask', 'MASK ICON', attr(tag, 'href'));
    else if (rel.split(/\s+/).includes('icon') || rel.includes('shortcut'))
      add('icon', 'FAVICON', attr(tag, 'href'));
  }
  // Always try the conventional favicon as a fallback.
  add('favicon', 'FAVICON', '/favicon.ico');
  return out;
}

/**
 * Fetch a page and return the icon/social images it advertises, decoded and
 * re-encoded to PNG (ICO/SVG/WebP all normalised). Largest images first.
 */
export async function fetchSourceImages(pageUrl: string): Promise<SourceImage[]> {
  const page = await safeFetch(pageUrl, HTML_MAX);
  const html = page.body.toString('utf8');
  const candidates = extractCandidates(html, page.finalUrl).slice(0, MAX_CANDIDATES);

  const results: SourceImage[] = [];
  for (const c of candidates) {
    if (results.length >= MAX_RESULTS) break;
    try {
      const img = await safeFetch(c.url, IMAGE_MAX);
      if (img.body.length === 0) continue;
      const png = await sharp(img.body).png().toBuffer();
      const meta = await sharp(png).metadata();
      results.push({
        kind: c.kind,
        label: c.label,
        png,
        width: meta.width ?? 0,
        height: meta.height ?? 0,
      });
    } catch {
      // skip undecodable / unreachable candidate
    }
  }
  if (results.length === 0) throw new LinkError('No usable images found on that page');
  // Biggest first — usually the best source to brick-ify.
  results.sort((a, b) => b.width * b.height - a.width * a.height);
  return results;
}
