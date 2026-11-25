/**
 * PICO-8 16-color palette — the single source of truth for every color in
 * the game: client rendering, CSS, and server-side brick image quantization.
 */
export const PALETTE = [
  '#000000', // 0 black
  '#1D2B53', // 1 dark blue
  '#7E2553', // 2 dark purple
  '#008751', // 3 dark green
  '#AB5236', // 4 brown
  '#5F574F', // 5 dark gray
  '#C2C3C7', // 6 light gray
  '#FFF1E8', // 7 white
  '#FF004D', // 8 red
  '#FFA300', // 9 orange
  '#FFEC27', // 10 yellow
  '#00E436', // 11 green
  '#29ADFF', // 12 blue
  '#83769C', // 13 lavender
  '#FF77A8', // 14 pink
  '#FFCCAA', // 15 peach
] as const;

/** RGB triples in palette order. */
export const PALETTE_RGB = PALETTE.map((hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]) as ReadonlyArray<readonly [number, number, number]>;

/** Index of the palette color nearest to the given RGB (Euclidean). */
export function nearestPaletteIndex(r: number, g: number, b: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < PALETTE_RGB.length; i++) {
    const c = PALETTE_RGB[i];
    if (!c) continue;
    const dist = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}
