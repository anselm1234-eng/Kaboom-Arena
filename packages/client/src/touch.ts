import { create as createJoystick } from 'nipplejs';
import type { Direction } from '@blastmates/shared';

/**
 * True on devices whose primary pointer is a finger. Feature detection only
 * (no UA sniffing): hybrid laptops with a precise trackpad stay on keyboard.
 */
export function isTouchDevice(): boolean {
  return window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
}

/** Deadzone as a fraction of full joystick travel; below it intent is "stop". */
const DEADZONE = 0.15;
/** The other axis must dominate by this factor before we switch axes. */
const AXIS_HYSTERESIS = 1.25;
/** Outer circle diameter in px (nipplejs renders the knob at half this). */
const JOY_SIZE = 110;

export interface TouchCallbacks {
  onDir: (dir: Direction | null) => void;
  onBomb: () => void;
}

/**
 * Floating virtual gamepad: a nipplejs dynamic joystick that spawns wherever
 * the thumb lands inside a large left-side zone (with `follow`, so the base
 * chases the thumb and direction reversals never require re-centering), plus
 * a bomb button bottom-right. The zone and the button capture independently,
 * so moving with one thumb and bombing with the other never conflict.
 */
export class TouchControls {
  private root: HTMLDivElement;
  private zone: HTMLDivElement;
  private bomb: HTMLDivElement;
  private manager: ReturnType<typeof createJoystick> | null = null;
  private dir: Direction | null = null;

  constructor(parent: HTMLElement, bombIconUrl: string, private cb: TouchCallbacks) {
    this.root = document.createElement('div');
    this.root.id = 'touch-controls';

    this.zone = document.createElement('div');
    this.zone.id = 'joy-zone';

    this.bomb = document.createElement('div');
    this.bomb.id = 'btn-bomb';
    const icon = document.createElement('img');
    icon.src = bombIconUrl;
    icon.alt = 'bomb';
    icon.draggable = false;
    this.bomb.appendChild(icon);

    this.root.append(this.zone, this.bomb);
    parent.appendChild(this.root);
    this.attach();
  }

  setVisible(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
    if (!on) this.setDir(null);
  }

  /** Re-emit the held direction (after a reconnect wiped downstream state). */
  resync(): void {
    if (this.dir !== null) this.cb.onDir(this.dir);
  }

  private attach(): void {
    this.manager = createJoystick({
      zone: this.zone,
      mode: 'dynamic',
      follow: true,
      size: JOY_SIZE,
      threshold: DEADZONE,
      fadeTime: 180,
      color: {
        front: 'rgba(255, 241, 232, 0.55)',
        back: 'rgba(29, 43, 83, 0.45)',
      },
    });
    this.manager.on('move', (evt) => {
      // A touch held across setVisible(false) keeps streaming moves; while
      // hidden the player must stay stopped.
      if (this.root.classList.contains('hidden')) return;
      const { vector, force } = evt.data;
      // nipplejs vectors are y-up; quantize() works in screen coords (y-down).
      this.setDir(this.quantize(vector.x, -vector.y, force));
    });
    this.manager.on('end', () => this.setDir(null));
    // Safety net: WebKit can drop the touch-end when the app is backgrounded
    // mid-touch, which would leave the player walking forever.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.setDir(null);
    });

    this.bomb.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      this.bomb.classList.add('active');
      this.cb.onBomb();
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      this.bomb.addEventListener(type, () => this.bomb.classList.remove('active'));
    }
  }

  /**
   * Strict 4-way: dominant axis wins, with hysteresis so wobbling near a
   * diagonal doesn't flap between axes. Sign flips on the same axis are
   * immediate (left<->right reversals must feel crisp).
   */
  private quantize(dx: number, dy: number, force: number): Direction | null {
    if (force < DEADZONE) return null;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const horizontal =
      this.dir === 'left' || this.dir === 'right'
        ? ay < ax * AXIS_HYSTERESIS
        : this.dir === 'up' || this.dir === 'down'
          ? ax >= ay * AXIS_HYSTERESIS
          : ax >= ay;
    if (horizontal) return dx < 0 ? 'left' : 'right';
    return dy < 0 ? 'up' : 'down';
  }

  private setDir(dir: Direction | null): void {
    if (this.dir === dir) return;
    this.dir = dir;
    if (dir) this.zone.dataset['dir'] = dir;
    else delete this.zone.dataset['dir'];
    this.cb.onDir(dir);
  }
}
