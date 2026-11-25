/** Cool room names: ADJECTIVE + PLACE, e.g. "SPICY BUNKER", "TURBO CRATER". */

const ADJECTIVES = [
  'BLAZING',
  'TURBO',
  'SNEAKY',
  'ROWDY',
  'SPICY',
  'WOBBLY',
  'MIGHTY',
  'RUSTY',
  'NEON',
  'GRUMPY',
  'JOLLY',
  'COSMIC',
  'CRISPY',
  'SMOKY',
  'DIZZY',
  'ATOMIC',
  'BOUNCY',
  'SALTY',
  'SHINY',
  'HASTY',
  'ROGUE',
  'FERAL',
  'MELLOW',
  'SAVAGE',
];

const PLACES = [
  'ARENA',
  'PIT',
  'BAZAAR',
  'BUNKER',
  'CRATER',
  'DOJO',
  'FOUNDRY',
  'JUNGLE',
  'KITCHEN',
  'LAGOON',
  'FORTRESS',
  'ALLEY',
  'GARAGE',
  'TEMPLE',
  'HARBOR',
  'CANYON',
  'CASTLE',
  'CELLAR',
  'ROOFTOP',
  'SWAMP',
  'PLAZA',
  'QUARRY',
  'VOLCANO',
  'OUTPOST',
];

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)] as T;
}

/** A name not currently in use; falls back to a duplicate if all are taken. */
export function randomRoomName(rng: () => number, taken: ReadonlySet<string>): string {
  let name = `${pick(rng, ADJECTIVES)} ${pick(rng, PLACES)}`;
  for (let i = 0; i < 50 && taken.has(name); i++) {
    name = `${pick(rng, ADJECTIVES)} ${pick(rng, PLACES)}`;
  }
  return name;
}
