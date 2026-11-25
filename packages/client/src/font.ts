import { color, type PaletteIndex } from './palette';

/**
 * Tiny 3x5 bitmap font rendered as filled rects — no canvas text, so no
 * anti-aliasing and no off-palette pixels.
 */
const GLYPHS: Record<string, string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#.#', '###', '###', '#.#', '#.#'],
  N: ['#.#', '###', '###', '###', '#.#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '#.#', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#.#', '#.#', '###', '###', '#.#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  '0': ['.#.', '#.#', '#.#', '#.#', '.#.'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['###', '..#', '.##', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['.##', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '##.'],
  '.': ['...', '...', '...', '...', '.#.'],
  ',': ['...', '...', '...', '.#.', '#..'],
  '!': ['.#.', '.#.', '.#.', '...', '.#.'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
  ':': ['...', '.#.', '...', '.#.', '...'],
  '-': ['...', '...', '###', '...', '...'],
  '+': ['...', '.#.', '###', '.#.', '...'],
  "'": ['.#.', '.#.', '...', '...', '...'],
  '/': ['..#', '..#', '.#.', '#..', '#..'],
  '(': ['.#.', '#..', '#..', '#..', '.#.'],
  ')': ['.#.', '..#', '..#', '..#', '.#.'],
  ' ': ['...', '...', '...', '...', '...'],
};

export const GLYPH_W = 3;
export const GLYPH_H = 5;
const SPACING = 1;

export function textWidth(text: string, scale = 1): number {
  return text.length * (GLYPH_W + SPACING) * scale - SPACING * scale;
}

/** Draw text at integer pixel coords using only palette colors. */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  colorIdx: PaletteIndex,
  scale = 1,
): void {
  ctx.fillStyle = color(colorIdx);
  let cx = Math.round(x);
  const cy = Math.round(y);
  for (const raw of text.toUpperCase()) {
    const glyph = GLYPHS[raw] ?? GLYPHS['?'];
    if (glyph) {
      for (let row = 0; row < GLYPH_H; row++) {
        const line = glyph[row] ?? '';
        for (let col = 0; col < GLYPH_W; col++) {
          if (line[col] === '#') {
            ctx.fillRect(cx + col * scale, cy + row * scale, scale, scale);
          }
        }
      }
    }
    cx += (GLYPH_W + SPACING) * scale;
  }
}

/** Draw text with a 1px drop shadow (shadow first, then text). */
export function drawTextShadowed(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  colorIdx: PaletteIndex,
  shadowIdx: PaletteIndex = 0,
  scale = 1,
): void {
  drawText(ctx, text, x + scale, y + scale, shadowIdx, scale);
  drawText(ctx, text, x, y, colorIdx, scale);
}

export function drawTextCentered(
  ctx: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  y: number,
  colorIdx: PaletteIndex,
  shadowIdx: PaletteIndex | null = 0,
  scale = 1,
): void {
  const x = Math.round(centerX - textWidth(text, scale) / 2);
  if (shadowIdx === null) drawText(ctx, text, x, y, colorIdx, scale);
  else drawTextShadowed(ctx, text, x, y, colorIdx, shadowIdx, scale);
}
