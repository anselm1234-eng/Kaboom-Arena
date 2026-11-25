import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PALETTE_RGB } from '@blastmates/shared';
import {
  BRICK_VARIANTS,
  ditherRgbToPalette,
  framePreview,
  renderAllVariants,
  renderBrickVariant,
} from '../src/images';
import { extractCandidates, ipPrivate } from '../src/linkpreview';

async function logoPng(): Promise<Buffer> {
  // A small two-tone "logo" with a gradient-y blend to exercise dithering.
  return sharp({ create: { width: 200, height: 200, channels: 3, background: '#ffffff' } })
    .composite([
      { input: { create: { width: 120, height: 120, channels: 3, background: '#2266dd' } }, left: 40, top: 40 },
    ])
    .png()
    .toBuffer();
}

async function decode(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function allInPalette(data: Buffer): boolean {
  for (let i = 0; i + 2 < data.length; i += 3) {
    if (!PALETTE_RGB.some((c) => c[0] === data[i] && c[1] === data[i + 1] && c[2] === data[i + 2]))
      return false;
  }
  return true;
}

describe('brick studio rendering', () => {
  it('renders every advertised variant with palette-pure tiles', async () => {
    const input = await logoPng();
    const variants = await renderAllVariants(input, 3);
    expect(variants.map((v) => v.key)).toEqual(BRICK_VARIANTS.map((v) => v.key));
    for (const v of variants) {
      expect(v.tiles).toHaveLength(3);
      for (const tile of v.tiles) {
        const { data, width, height } = await decode(tile);
        expect([width, height]).toEqual([16, 16]);
        expect(allInPalette(data)).toBe(true);
      }
      const full = await decode(v.full);
      expect([full.width, full.height]).toEqual([48, 16]);
      // The framed preview is the strip on a floor margin, upscaled.
      const framed = await decode(v.framed);
      expect(framed.width).toBeGreaterThan(48);
      expect(framed.height).toBeGreaterThan(16);
    }
  });

  it('rejects an unknown variant key', async () => {
    await expect(renderBrickVariant(await logoPng(), 1, 'nope')).rejects.toThrow();
  });

  it('dithers only to palette colors', async () => {
    const w = 8;
    const h = 8;
    const raw = Buffer.alloc(w * h * 3, 100); // mid-gray, off-palette
    ditherRgbToPalette(raw, w, h);
    expect(allInPalette(raw)).toBe(true);
  });

  it('frames a strip onto the arena floor', async () => {
    const raw = Buffer.alloc(48 * 16 * 3, 0);
    const png = await framePreview(raw, 3, 4);
    const { width, height } = await decode(png);
    expect(width).toBe((48 + 12) * 4);
    expect(height).toBe((16 + 12) * 4);
  });
});

describe('link preview extraction', () => {
  it('pulls icons and social images and resolves relative URLs', () => {
    const html = `
      <html><head>
        <meta property="og:image" content="https://cdn.example.com/og.png" />
        <meta name="twitter:image" content="/tw.png" />
        <link rel="apple-touch-icon" href="/icons/apple.png" />
        <link rel="icon" href="favicon-32.png" />
      </head></html>`;
    const got = extractCandidates(html, 'https://example.com/page');
    const byUrl = Object.fromEntries(got.map((c) => [c.kind, c.url]));
    expect(byUrl.og).toBe('https://cdn.example.com/og.png');
    expect(byUrl.twitter).toBe('https://example.com/tw.png');
    expect(byUrl.apple).toBe('https://example.com/icons/apple.png');
    expect(byUrl.icon).toBe('https://example.com/favicon-32.png');
    // Always offers the conventional favicon as a fallback.
    expect(got.some((c) => c.url === 'https://example.com/favicon.ico')).toBe(true);
  });

  it('flags private / loopback / link-local addresses as unsafe', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.3.4', '169.254.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(ipPrivate(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(ipPrivate(ip)).toBe(false);
    }
  });
});
