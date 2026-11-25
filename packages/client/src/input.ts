import type { Direction } from '@blastmates/shared';
import type { PadBindings } from './keymaps';

/** One local player's input state (held keys, last sent intent). */
class Pad {
  held: Direction[] = [];
  touchDir: Direction | null = null;
  lastSent: Direction | null = null;
  /** Bomb key physically held: drives the auto-repeat placement loop. */
  bombHeld = false;
}

/**
 * While a bomb key is held we re-attempt placement on this cadence. The server
 * rejects attempts that have no capacity or land on an occupied tile, so this
 * just means "drop a bomb whenever I'm allowed to" - one per tile as you walk,
 * and another as soon as an earlier bomb clears.
 */
const BOMB_REPEAT_MS = 90;

interface KeyAction {
  pad: number;
  action: Direction | 'bomb';
}

/**
 * Routes keyboard (and touch) input to per-local-player pads. Each pad tracks
 * held movement keys (most recent wins, releases fall back to a still-held
 * key) and emits changes of intent plus bomb presses, tagged with the pad
 * index. Bindings are data-driven (see keymaps.ts) and re-mapped via
 * setBindings whenever the local player count changes.
 */
export class InputManager {
  private pads: Pad[] = [new Pad()];
  private keyActions = new Map<string, KeyAction[]>();
  private enabled = true;
  /** Interval firing held bombs; runs only while at least one bomb is held. */
  private bombTimer: number | null = null;

  onDirChange: (pad: number, dir: Direction | null) => void = () => {};
  onBomb: (pad: number) => void = () => {};

  /** Swap the active key layout; all held state starts from a clean slate. */
  setBindings(bindings: readonly PadBindings[]): void {
    this.pads = bindings.map(() => new Pad());
    this.stopBombRepeatIfIdle(); // fresh pads hold nothing; don't leak the old timer
    this.keyActions = new Map();
    bindings.forEach((b, pad) => {
      const add = (codes: readonly string[], action: Direction | 'bomb'): void => {
        for (const code of codes) {
          const list = this.keyActions.get(code) ?? [];
          list.push({ pad, action });
          this.keyActions.set(code, list);
        }
      };
      add(b.up, 'up');
      add(b.down, 'down');
      add(b.left, 'left');
      add(b.right, 'right');
      add(b.bomb, 'bomb');
    });
  }

  /**
   * Gate game keys for ALL pads (e.g. while a menu overlay is open).
   * Disabling releases all held movement so every local player stops;
   * re-enabling starts clean - keys still physically held must be re-pressed.
   */
  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) {
      for (let i = 0; i < this.pads.length; i++) {
        const pad = this.pads[i];
        if (!pad) continue;
        pad.held = [];
        pad.touchDir = null;
        pad.bombHeld = false; // menu/portrait gate: re-press to bomb again
        this.emit(i);
      }
      this.stopBombRepeatIfIdle();
    }
  }

  current(padIdx = 0): Direction | null {
    const pad = this.pads[padIdx];
    if (!pad) return null;
    return pad.touchDir ?? pad.held[pad.held.length - 1] ?? null;
  }

  /** Virtual joystick intent; feeds pad 0 like its keyboard keys. */
  setTouchDir(dir: Direction | null): void {
    const pad = this.pads[0];
    if (!pad) return;
    if (!this.enabled && dir !== null) return;
    if (pad.touchDir === dir) return;
    pad.touchDir = dir;
    this.emit(0);
  }

  /** Virtual bomb button press; same gate and callback as the bomb key. */
  touchBomb(): boolean {
    if (!this.enabled) return false;
    this.onBomb(0);
    return true;
  }

  attach(): void {
    window.addEventListener('keydown', (ev) => {
      if (ev.repeat || !this.enabled) return;
      const actions = this.keyActions.get(ev.code);
      if (!actions || !this.isGameKeyContext(ev)) return;
      ev.preventDefault();
      for (const { pad: padIdx, action } of actions) {
        const pad = this.pads[padIdx];
        if (!pad) continue;
        if (action === 'bomb') {
          // Place one immediately so a quick tap is instant, then keep dropping
          // bombs on a timer for as long as the key stays held.
          pad.bombHeld = true;
          this.onBomb(padIdx);
          this.startBombRepeat();
        } else {
          pad.held = pad.held.filter((d) => d !== action);
          pad.held.push(action);
          this.emit(padIdx);
        }
      }
    });
    window.addEventListener('keyup', (ev) => {
      const actions = this.keyActions.get(ev.code);
      if (!actions) return;
      for (const { pad: padIdx, action } of actions) {
        const pad = this.pads[padIdx];
        if (!pad) continue;
        if (action === 'bomb') {
          pad.bombHeld = false;
          this.stopBombRepeatIfIdle();
          continue;
        }
        pad.held = pad.held.filter((d) => d !== action);
        this.emit(padIdx);
      }
    });
    // Losing window focus can swallow keyups, so drop held *keys* to avoid a
    // stuck walk. Touch intent is deliberately left alone: the joystick owns
    // it (nipplejs fires pointercancel/'end' when a touch is truly cut, and
    // visibilitychange stops us when backgrounded), so a transient blur - the
    // notification shade, the URL bar, a permission prompt - must NOT freeze a
    // player whose thumb is still resting on the stick.
    window.addEventListener('blur', () => {
      for (let i = 0; i < this.pads.length; i++) {
        const pad = this.pads[i];
        if (!pad) continue;
        pad.held = [];
        // A swallowed keyup must not leave the bomb auto-repeat running.
        pad.bombHeld = false;
        this.emit(i);
      }
      this.stopBombRepeatIfIdle();
    });
  }

  /** Begin the auto-repeat loop if it isn't already running. */
  private startBombRepeat(): void {
    if (this.bombTimer !== null) return;
    this.bombTimer = window.setInterval(() => {
      if (!this.enabled) return;
      for (let i = 0; i < this.pads.length; i++) {
        if (this.pads[i]?.bombHeld) this.onBomb(i);
      }
    }, BOMB_REPEAT_MS);
  }

  /** Stop the loop once no pad is holding a bomb key (saves an idle timer). */
  private stopBombRepeatIfIdle(): void {
    if (this.bombTimer === null) return;
    if (this.pads.some((pad) => pad.bombHeld)) return;
    window.clearInterval(this.bombTimer);
    this.bombTimer = null;
  }

  private isGameKeyContext(ev: KeyboardEvent): boolean {
    return !(ev.target instanceof HTMLInputElement);
  }

  private emit(padIdx: number): void {
    const pad = this.pads[padIdx];
    if (!pad) return;
    const dir = this.current(padIdx);
    if (dir !== pad.lastSent) {
      pad.lastSent = dir;
      this.onDirChange(padIdx, dir);
    }
  }

  /**
   * Re-send held directions even though they haven't changed. Each round the
   * server starts everyone at dir null, so a thumb resting on the joystick
   * through the round-end banner would otherwise leave the player frozen.
   */
  resend(): void {
    for (let i = 0; i < this.pads.length; i++) {
      const pad = this.pads[i];
      if (!pad) continue;
      pad.lastSent = null;
      if (this.current(i) !== null) this.emit(i);
    }
  }

  reset(): void {
    for (const pad of this.pads) {
      pad.held = [];
      pad.touchDir = null;
      pad.lastSent = null;
      pad.bombHeld = false;
    }
    this.stopBombRepeatIfIdle();
  }
}
