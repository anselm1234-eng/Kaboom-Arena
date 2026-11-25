import { WebHaptics } from 'web-haptics';
import type { SnapshotMessage } from '@blastmates/shared';

const STORAGE_KEY = 'haptics';

/**
 * Haptic feedback, touch devices only. web-haptics uses navigator.vibrate
 * where available (Android) and falls back to the hidden <input switch>
 * label-click trick on iOS Safari, where vibrate() doesn't exist. Anything
 * unsupported degrades to a silent no-op.
 */
export class Haptics {
  /** Only ever true on touch devices; desktop never gets an instance. */
  private wh: WebHaptics | null = null;
  private on: boolean;

  constructor(private touchDevice: boolean) {
    this.on = localStorage.getItem(STORAGE_KEY) !== 'off';
    if (touchDevice) {
      try {
        this.wh = new WebHaptics();
      } catch {
        this.wh = null;
      }
    }
  }

  enabled(): boolean {
    return this.on;
  }

  setEnabled(on: boolean): void {
    this.on = on;
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  }

  available(): boolean {
    return this.touchDevice && this.wh !== null;
  }

  trigger(preset: 'light' | 'medium' | 'heavy' | 'error' | 'success'): void {
    if (!this.on || !this.wh) return;
    try {
      void this.wh.trigger(preset).catch(() => {});
    } catch {
      // Haptics must never break the game.
    }
  }
}

/**
 * Derives the local player's haptic moments by diffing snapshots, mirroring
 * how Fx derives visuals - no extra netcode, bots and remote players excluded
 * by ownerId/playerId checks.
 *
 * Intensity ladder: move tick 'light' < bomb press 'medium' < own bomb boom
 * 'heavy' < death 'error' (three sharp taps: on Android the intensity reads
 * as strong, and on iOS - where each tap is a uniform switch click - the
 * repetition is what distinguishes it from single-tap events).
 */
export class HapticEvents {
  private prevTick: number | null = null;
  private prevMyBombs = new Set<string>();
  private prevExplosions = new Set<string>();
  private prevAlive = true;
  private prevServerTime: number | null = null;

  constructor(private haptics: Haptics) {}

  reset(): void {
    this.prevTick = null;
    this.prevMyBombs = new Set();
    this.prevExplosions = new Set();
    this.prevAlive = true;
    this.prevServerTime = null;
  }

  processSnapshot(snap: SnapshotMessage, myId: string | null): void {
    if (!myId) return;
    const myBombs = new Set<string>();
    for (const b of snap.bombs) if (b.ownerId === myId) myBombs.add(b.id);
    const explosions = new Set<string>();
    for (const e of snap.explosions) explosions.add(e.id);
    const me = snap.players.find((p) => p.id === myId);
    const alive = me?.alive ?? this.prevAlive;

    if (this.prevTick !== null && snap.tick > this.prevTick) {
      const ownExploded = [...this.prevMyBombs].some((id) => !myBombs.has(id));
      const anyNewExplosion = [...explosions].some((id) => !this.prevExplosions.has(id));
      if (ownExploded) {
        this.haptics.trigger('heavy'); // own bomb exploded
      } else if (anyNewExplosion) {
        this.haptics.trigger('light'); // someone else's bomb went off
      }
      if (this.prevAlive && me && !alive) this.haptics.trigger('error'); // own death
      if (
        snap.suddenDeathAt !== undefined &&
        this.prevServerTime !== null &&
        this.prevServerTime < snap.suddenDeathAt &&
        snap.serverTime >= snap.suddenDeathAt
      ) {
        this.haptics.trigger('medium'); // sudden death begins
      }
    }

    this.prevServerTime = snap.serverTime;
    this.prevTick = snap.tick;
    this.prevMyBombs = myBombs;
    this.prevExplosions = explosions;
    this.prevAlive = alive;
  }

  /** Instant feedback the moment the bomb button is pressed (no net round-trip). */
  bombPressed(): void {
    this.haptics.trigger('medium');
  }

  matchWon(): void {
    this.haptics.trigger('success');
  }

  /** AFK warning appeared: triple sharp taps so it cuts through idleness. */
  afkWarning(): void {
    this.haptics.trigger('error');
  }

  /**
   * Light tick on joystick direction change. Delete the body if it feels
   * buzzy/spammy during real play.
   */
  joystickTick(): void {
    this.haptics.trigger('light');
  }
}
