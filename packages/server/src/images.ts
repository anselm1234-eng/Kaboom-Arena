import sharp from 'sharp';
import { PALETTE_RGB, nearestPaletteIndex } from '@blastmates/shared';
import type { BrickSize } from './store';

export const TILE_PX = 16;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export type ImageType = 'png' | 'jpeg';

/** Magic-byte sniffing — never trust extensions or content-type headers. */
export function sniffImageType(buf: Buffer): ImageType | null {
  if (
    buf.length > 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpeg';
  }
  return null;
}

/** Map raw RGB pixels onto the PICO-8 palette in place. */
export function quantizeRgbToPalette(raw: Buffer, channels: number): Buffer {
  for (let i = 0; i + 2 < raw.length; i += channels) {
    const idx = nearestPaletteIndex(raw[i] ?? 0, raw[i + 1] ?? 0, raw[i + 2] ?? 0);
    const c = PALETTE_RGB[idx];
    if (c) {
      raw[i] = c[0];
      raw[i + 1] = c[1];
      raw[i + 2] = c[2];
    }
  }
  return raw;
}

export interface ProcessedBrickImage {
  /** One 16x16 PNG per tile, left to right. */
  tiles: Buffer[];
  /** The whole quantized strip (size*16 x 16) as a PNG. */
  full: Buffer;
}

export class ImageError extends Error {
  constructor(readonly code: 'bad_type' | 'too_large' | 'decode_failed', message: string) {
    super(message);
  }
}

/**
 * Crop to the target aspect, downscale to (size*16)x16, quantize to the
 * PICO-8 palette and slice into 16x16 tiles. Re-encoding strips all
 * metadata; EXIF orientation is applied first.
 */
export async function processBrickImage(
  input: Buffer,
  size: BrickSize,
): Promise<ProcessedBrickImage> {
  if (input.length > MAX_UPLOAD_BYTES) {
    throw new ImageError('too_large', 'Image exceeds 2MB');
  }
  if (sniffImageType(input) === null) {
    throw new ImageError('bad_type', 'Only PNG and JPEG images are supported');
  }
  const width = size * TILE_PX;
  let raw: Buffer;
  try {
    raw = await sharp(input, { limitInputPixels: 30_000_000 })
      .rotate() // apply EXIF orientation, drop the tag
      .flatten({ background: '#000000' })
      .resize(width, TILE_PX, { fit: 'cover', kernel: 'lanczos3' })
      .removeAlpha()
      .raw()
      .toBuffer();
  } catch {
    throw new ImageError('decode_failed', 'Could not decode the image');
  }

  quantizeRgbToPalette(raw, 3);
  return sliceAndEncode(raw, size);
}

// --- Multi-variant "studio" rendering ----------------------------------------
// Real logos/photos quantize badly with a naive nearest-color pass, so we offer
// the buyer several genuinely different renders (different crop, contrast and
// dithering) and let them pick the one that reads best as a 3-crate brick.

export interface BrickVariant {
  key: string;
  label: string;
  hint: string;
}

interface VariantConfig extends BrickVariant {
  bg: string;
  fit: 'cover' | 'contain';
  trim: boolean;
  saturation: number;
  brightness: number;
  /** linear contrast [multiply, add]; null = leave as-is. */
  contrast: [number, number] | null;
  sharpen: boolean;
  normalize: boolean;
  dither: boolean;
}

const VARIANTS: VariantConfig[] = [
  {
    key: 'fill',
    label: 'FILL · VIVID',
    hint: 'fills every crate, punchy colors',
    bg: '#ffffff',
    fit: 'cover',
    trim: true,
    saturation: 1.75,
    brightness: 1.05,
    contrast: [1.32, -26],
    sharpen: true,
    normalize: true,
    dither: false,
  },
  {
    key: 'fill-soft',
    label: 'FILL · SMOOTH',
    hint: 'fills every crate, dithered gradients',
    bg: '#ffffff',
    fit: 'cover',
    trim: true,
    saturation: 1.45,
    brightness: 1.02,
    contrast: null,
    sharpen: false,
    normalize: true,
    dither: true,
  },
  {
    key: 'fit',
    label: 'WHOLE LOGO',
    hint: 'shows the entire logo, white sides',
    bg: '#ffffff',
    fit: 'contain',
    trim: true,
    saturation: 1.5,
    brightness: 1.0,
    contrast: [1.22, -18],
    sharpen: true,
    normalize: false,
    dither: false,
  },
  {
    key: 'fit-soft',
    label: 'WHOLE · SMOOTH',
    hint: 'entire logo, dithered',
    bg: '#ffffff',
    fit: 'contain',
    trim: true,
    saturation: 1.35,
    brightness: 1.0,
    contrast: null,
    sharpen: false,
    normalize: true,
    dither: true,
  },
  {
    key: 'dark',
    label: 'ON BLACK',
    hint: 'best for white or transparent logos',
    bg: '#000000',
    fit: 'contain',
    trim: true,
    saturation: 1.6,
    brightness: 1.12,
    contrast: [1.18, -8],
    sharpen: true,
    normalize: false,
    dither: false,
  },
];

export const BRICK_VARIANTS: BrickVariant[] = VARIANTS.map((v) => ({
  key: v.key,
  label: v.label,
  hint: v.hint,
}));

function clamp8(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/** Floyd–Steinberg error-diffusion dithering onto the palette, in place. */
export function ditherRgbToPalette(raw: Buffer, width: number, height: number): void {
  const buf = Float32Array.from(raw);
  const at = (x: number, y: number): number => (y * width + x) * 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = at(x, y);
      const r = clamp8(buf[i] ?? 0);
      const g = clamp8(buf[i + 1] ?? 0);
      const b = clamp8(buf[i + 2] ?? 0);
      const idx = nearestPaletteIndex(r, g, b);
      const c = PALETTE_RGB[idx] ?? [0, 0, 0];
      raw[i] = c[0];
      raw[i + 1] = c[1];
      raw[i + 2] = c[2];
      const er = r - c[0];
      const eg = g - c[1];
      const eb = b - c[2];
      const spread = (x2: number, y2: number, f: number): void => {
        if (x2 < 0 || x2 >= width || y2 < 0 || y2 >= height) return;
        const j = at(x2, y2);
        buf[j] = (buf[j] ?? 0) + (er * f) / 16;
        buf[j + 1] = (buf[j + 1] ?? 0) + (eg * f) / 16;
        buf[j + 2] = (buf[j + 2] ?? 0) + (eb * f) / 16;
      };
      spread(x + 1, y, 7);
      spread(x - 1, y + 1, 3);
      spread(x, y + 1, 5);
      spread(x + 1, y + 1, 1);
    }
  }
}

function sliceTilesRaw(raw: Buffer, size: BrickSize): Buffer[] {
  const width = size * TILE_PX;
  const tiles: Buffer[] = [];
  for (let t = 0; t < size; t++) {
    const tileRaw = Buffer.alloc(TILE_PX * TILE_PX * 3);
    for (let y = 0; y < TILE_PX; y++) {
      const srcStart = (y * width + t * TILE_PX) * 3;
      raw.copy(tileRaw, y * TILE_PX * 3, srcStart, srcStart + TILE_PX * 3);
    }
    tiles.push(tileRaw);
  }
  return tiles;
}

async function rawToPng(raw: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function sliceAndEncode(raw: Buffer, size: BrickSize): Promise<ProcessedBrickImage> {
  const width = size * TILE_PX;
  const full = await rawToPng(raw, width, TILE_PX);
  const tiles = await Promise.all(sliceTilesRaw(raw, size).map((t) => rawToPng(t, TILE_PX, TILE_PX)));
  return { tiles, full };
}

/** Run a variant's preprocessing pipeline down to a quantized width*16 RGB buffer. */
async function variantRaw(input: Buffer, size: BrickSize, cfg: VariantConfig): Promise<Buffer> {
  const width = size * TILE_PX;
  let src = input;
  if (cfg.trim) {
    try {
      src = await sharp(input).trim({ threshold: 12 }).png().toBuffer();
    } catch {
      src = input; // a uniform image can't be trimmed — fine
    }
  }
  let img = sharp(src, { limitInputPixels: 30_000_000 })
    .rotate()
    .flatten({ background: cfg.bg })
    .resize(width, TILE_PX, { fit: cfg.fit, kernel: 'lanczos3', background: cfg.bg, position: 'centre' })
    .modulate({ saturation: cfg.saturation, brightness: cfg.brightness });
  if (cfg.normalize) img = img.normalise();
  if (cfg.contrast) img = img.linear(cfg.contrast[0], cfg.contrast[1]);
  if (cfg.sharpen) img = img.sharpen({ sigma: 0.6 });
  const raw = await img.removeAlpha().raw().toBuffer();
  if (cfg.dither) ditherRgbToPalette(raw, width, TILE_PX);
  else quantizeRgbToPalette(raw, 3);
  return raw;
}

/** One rendered option: in-game tiles + a framed preview that matches a match. */
export interface RenderedVariant extends BrickVariant {
  tiles: Buffer[];
  full: Buffer;
  framed: Buffer;
}

export async function renderBrickVariant(
  input: Buffer,
  size: BrickSize,
  key: string,
): Promise<RenderedVariant> {
  if (input.length > MAX_UPLOAD_BYTES) throw new ImageError('too_large', 'Image exceeds 2MB');
  if (sniffImageType(input) === null) {
    // Sources fetched from a URL can be webp/svg/etc.; re-encode to png first.
    try {
      input = await sharp(input).png().toBuffer();
    } catch {
      throw new ImageError('bad_type', 'Unsupported image');
    }
  }
  const cfg = VARIANTS.find((v) => v.key === key);
  if (!cfg) throw new ImageError('bad_type', 'Unknown render style');
  let raw: Buffer;
  try {
    raw = await variantRaw(input, size, cfg);
  } catch {
    throw new ImageError('decode_failed', 'Could not process the image');
  }
  const encoded = await sliceAndEncode(raw, size);
  const framed = await framePreview(raw, size, 6);
  return { key: cfg.key, label: cfg.label, hint: cfg.hint, ...encoded, framed };
}

/** Render every variant for a source image (skipping any that error out). */
export async function renderAllVariants(input: Buffer, size: BrickSize): Promise<RenderedVariant[]> {
  const out: RenderedVariant[] = [];
  for (const v of VARIANTS) {
    try {
      out.push(await renderBrickVariant(input, size, v.key));
    } catch {
      // skip a variant that fails rather than failing the whole preview
    }
  }
  return out;
}

// --- In-game framed preview (matches client drawBrandedCrate) ----------------

const FLOOR_RGB: [number, number, number] = [0, 135, 81]; // palette 3 (arena floor)
const FLOOR_SPECK: [number, number, number] = [29, 43, 83]; // palette 1
const FRAME_RGB: [number, number, number] = [0, 0, 0]; // black tile frame
const NAIL_RGB: [number, number, number] = [194, 195, 199]; // palette 6 corner nails

/**
 * Compose the quantized strip exactly as the game draws a branded crate: each
 * 16px tile gets a 1px black frame + corner nails, the tiles sit on the floor,
 * and the whole thing is nearest-neighbour upscaled by `scale`.
 */
export async function framePreview(raw: Buffer, size: BrickSize, scale: number): Promise<Buffer> {
  const cols = size * TILE_PX;
  const margin = 6;
  const w = cols + margin * 2;
  const h = TILE_PX + margin * 2;
  const out = Buffer.alloc(w * h * 3);
  const put = (x: number, y: number, c: [number, number, number]): void => {
    const i = (y * w + x) * 3;
    out[i] = c[0];
    out[i + 1] = c[1];
    out[i + 2] = c[2];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) put(x, y, (x * 7 + y * 13) % 37 === 0 ? FLOOR_SPECK : FLOOR_RGB);
  }
  for (let t = 0; t < size; t++) {
    const ox = margin + t * TILE_PX;
    for (let y = 0; y < TILE_PX; y++) {
      for (let x = 0; x < TILE_PX; x++) {
        const si = ((y * cols) + t * TILE_PX + x) * 3;
        put(ox + x, margin + y, [raw[si] ?? 0, raw[si + 1] ?? 0, raw[si + 2] ?? 0]);
      }
    }
    for (let x = 0; x < TILE_PX; x++) {
      put(ox + x, margin, FRAME_RGB);
      put(ox + x, margin + TILE_PX - 1, FRAME_RGB);
    }
    for (let y = 0; y < TILE_PX; y++) {
      put(ox, margin + y, FRAME_RGB);
      put(ox + TILE_PX - 1, margin + y, FRAME_RGB);
    }
    put(ox + 1, margin + 1, NAIL_RGB);
    put(ox + TILE_PX - 2, margin + 1, NAIL_RGB);
    put(ox + 1, margin + TILE_PX - 2, NAIL_RGB);
    put(ox + TILE_PX - 2, margin + TILE_PX - 2, NAIL_RGB);
  }
  return sharp(out, { raw: { width: w, height: h, channels: 3 } })
    .resize(w * scale, h * scale, { kernel: 'nearest' })
    .png()
    .toBuffer();
}
