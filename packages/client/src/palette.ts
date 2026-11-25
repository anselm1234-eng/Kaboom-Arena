import { PALETTE, PALETTE_RGB } from '@blastmates/shared';

export { PALETTE, PALETTE_RGB };

export type PaletteIndex = number;

export function color(i: PaletteIndex): string {
  return PALETTE[i] ?? '#000000';
}

/** Hex digit -> palette index used in sprite pixel maps. */
export function charToIndex(ch: string): PaletteIndex | null {
  if (ch === '.' || ch === ' ') return null;
  const v = parseInt(ch, 16);
  return Number.isNaN(v) ? null : v;
}
