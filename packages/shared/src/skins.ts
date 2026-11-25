/**
 * Cosmetic skin catalog. The 4 default palette swaps stay free; the skin
 * pack unlocks 8 extra palettes, 3 hats and an alternate victory dance.
 * Values are PICO-8 palette indices.
 */
export interface SkinPalette {
  main: number;
  shade: number;
}

export const SKIN_PALETTES: Record<string, SkinPalette> = {
  mint: { main: 11, shade: 3 },
  gold: { main: 10, shade: 9 },
  bubblegum: { main: 14, shade: 2 },
  peach: { main: 15, shade: 4 },
  ember: { main: 9, shade: 4 },
  lavender: { main: 13, shade: 5 },
  plum: { main: 2, shade: 1 },
  moss: { main: 3, shade: 1 },
};

export const SKIN_PALETTE_IDS = ['default', ...Object.keys(SKIN_PALETTES)] as [
  string,
  ...string[],
];
export const HAT_IDS = ['none', 'crown', 'tophat', 'halo'] as ['none', ...string[]];
export const DANCE_IDS = ['classic', 'bounce'] as ['classic', ...string[]];

export interface Skin {
  palette: string;
  hat: string;
  dance: string;
}

export const DEFAULT_SKIN: Skin = { palette: 'default', hat: 'none', dance: 'classic' };

/** True when the skin uses no paid cosmetics. */
export function isFreeSkin(skin: Skin): boolean {
  return skin.palette === 'default' && skin.hat === 'none' && skin.dance === 'classic';
}
