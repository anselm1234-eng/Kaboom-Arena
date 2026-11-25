/**
 * Adaptive local-multiplayer key layouts. The active preset depends only on
 * how many local players share this keyboard; all bindings live in this one
 * config object (KeyboardEvent.code values = physical keys, layout-agnostic)
 * so presets are tweakable and a rebinding UI can replace them later.
 */

export interface PadBindings {
  up: readonly string[];
  down: readonly string[];
  left: readonly string[];
  right: readonly string[];
  bomb: readonly string[];
}

export interface PadPreset {
  keys: PadBindings;
  /** Human-readable key labels, shown in the lobby and at match start. */
  moveLabel: string;
  bombLabel: string;
}

const WASD = { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'] } as const;
const ARROWS = {
  up: ['ArrowUp'],
  down: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
} as const;
const IJKL = { up: ['KeyI'], down: ['KeyK'], left: ['KeyJ'], right: ['KeyL'] } as const;
const NUMPAD = { up: ['Numpad8'], down: ['Numpad5'], left: ['Numpad4'], right: ['Numpad6'] } as const;

const SOLO: PadPreset = {
  // Solo keeps both classic schemes live at once (plus legacy X to bomb).
  keys: {
    up: [...WASD.up, ...ARROWS.up],
    down: [...WASD.down, ...ARROWS.down],
    left: [...WASD.left, ...ARROWS.left],
    right: [...WASD.right, ...ARROWS.right],
    bomb: ['Space', 'Enter', 'KeyX'],
  },
  moveLabel: 'WASD/ARROWS',
  bombLabel: 'SPACE/ENTER',
};

const P_WASD: PadPreset = { keys: { ...WASD, bomb: ['KeyV'] }, moveLabel: 'WASD', bombLabel: 'V' };
const P_IJKL: PadPreset = { keys: { ...IJKL, bomb: ['KeyH'] }, moveLabel: 'IJKL', bombLabel: 'H' };
const P_ARROWS: PadPreset = {
  keys: { ...ARROWS, bomb: ['ShiftRight'] },
  moveLabel: 'ARROWS',
  bombLabel: 'R-SHIFT',
};
const P_NUMPAD: PadPreset = {
  keys: { ...NUMPAD, bomb: ['Numpad0'] },
  moveLabel: 'NUM 8456',
  bombLabel: 'NUM 0',
};

/** Index = local player count - 1; entry i of a layout = local player i+1. */
export const LOCAL_LAYOUTS: readonly (readonly PadPreset[])[] = [
  [SOLO],
  [P_WASD, P_ARROWS],
  [P_WASD, P_IJKL, P_ARROWS],
  [P_WASD, P_IJKL, P_ARROWS, P_NUMPAD],
];

export function layoutFor(localCount: number): readonly PadPreset[] {
  const layout = LOCAL_LAYOUTS[Math.max(localCount, 1) - 1];
  return layout ?? LOCAL_LAYOUTS[LOCAL_LAYOUTS.length - 1] ?? [SOLO];
}
