import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PALETTE_RGB } from '@blastmates/shared';
import { ImageError, processBrickImage, sniffImageType } from '../src/images';

async function solidPng(width: number, height: number, rgb: string): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: rgb } })
    .png()
    .toBuffer();
}

async function decodeRaw(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function allPixelsInPalette(data: Buffer, channels: number): boolean {
  for (let i = 0; i + 2 < data.length; i += channels) {
    const match = PALETTE_RGB.some(
      (c) => c[0] === data[i] && c[1] === data[i + 1] && c[2] === data[i + 2],
    );
    if (!match) return false;
  }
  return true;
}

describe('file type sniffing', () => {
  it('detects png and jpeg by magic bytes, rejects everything else', async () => {
    const png = await solidPng(4, 4, '#ff0000');
    expect(sniffImageType(png)).toBe('png');
    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } })
      .jpeg()
      .toBuffer();
    expect(sniffImageType(jpeg)).toBe('jpeg');
    expect(sniffImageType(Buffer.from('GIF89a-not-allowed'))).toBeNull();
    expect(sniffImageType(Buffer.from('<svg xmlns="..."/>'))).toBeNull();
  });
});

describe('brick image processing', () => {
  it('produces the right number of 16x16 tiles per size', async () => {
    const input = await solidPng(300, 100, '#ff0000');
    for (const size of [1, 2, 3] as const) {
      const out = await processBrickImage(input, size);
      expect(out.tiles).toHaveLength(size);
      for (const tile of out.tiles) {
        const decoded = await decodeRaw(tile);
        expect(decoded.width).toBe(16);
        expect(decoded.height).toBe(16);
      }
      const full = await decodeRaw(out.full);
      expect(full.width).toBe(size * 16);
      expect(full.height).toBe(16);
    }
  });

  it('quantizes every pixel to the PICO-8 palette', async () => {
    // A gradient-ish image with off-palette colors.
    const input = await sharp({
      create: { width: 64, height: 32, channels: 3, background: '#123456' },
    })
      .composite([
        {
          input: await solidPng(20, 32, '#fe0102'),
          left: 0,
          top: 0,
        },
        {
          input: await solidPng(20, 32, '#88ff99'),
          left: 40,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    const out = await processBrickImage(input, 3);
    const full = await decodeRaw(out.full);
    expect(allPixelsInPalette(full.data, 3)).toBe(true);
    for (const tile of out.tiles) {
      const decoded = await decodeRaw(tile);
      expect(allPixelsInPalette(decoded.data, 3)).toBe(true);
    }
  });

  it('maps pure red to the PICO-8 red', async () => {
    const input = await solidPng(32, 32, '#ff0000');
    const out = await processBrickImage(input, 1);
    const { data } = await decodeRaw(out.tiles[0]!);
    expect([data[0], data[1], data[2]]).toEqual([0xff, 0x00, 0x4d]);
  });

  it('slices tiles left-to-right from the full strip', async () => {
    // Left half pure red, right half pure white -> tile 0 red, tile 1 white.
    const input = await sharp({
      create: { width: 32, height: 16, channels: 3, background: '#ff0000' },
    })
      .composite([{ input: await solidPng(16, 16, '#ffffff'), left: 16, top: 0 }])
      .png()
      .toBuffer();
    const out = await processBrickImage(input, 2);
    const t0 = await decodeRaw(out.tiles[0]!);
    const t1 = await decodeRaw(out.tiles[1]!);
    expect([t0.data[0], t0.data[1], t0.data[2]]).toEqual([0xff, 0x00, 0x4d]); // PICO-8 red
    expect([t1.data[0], t1.data[1], t1.data[2]]).toEqual([0xff, 0xf1, 0xe8]); // PICO-8 white
  });

  it('rejects oversized and non-image inputs', async () => {
    await expect(processBrickImage(Buffer.alloc(3 * 1024 * 1024), 1)).rejects.toThrow(ImageError);
    await expect(processBrickImage(Buffer.from('not an image'), 1)).rejects.toThrow(ImageError);
    // Valid magic bytes but corrupt body.
    const corrupt = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('garbage'),
    ]);
    await expect(processBrickImage(corrupt, 1)).rejects.toThrow(ImageError);
  });
});
