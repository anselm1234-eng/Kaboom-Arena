import {
  DEFAULT_ROOM_SIZE_DESKTOP,
  ROOM_SIZE_GRID,
  type PowerupKind,
  type SnapshotMessage,
} from '@blastmates/shared';

/**
 * Client-side juice derived purely from snapshot diffs — no extra netcode.
 * All times are server-clock milliseconds so clients stay consistent.
 */

export interface Particle {
  x: number; // world pixels (16px tiles)
  y: number;
  vx: number; // px per second
  vy: number;
  bornAt: number;
  lifeMs: number;
  colorIdx: number;
  size: 1 | 2;
  gravity: boolean;
}

export interface Crumble {
  cx: number;
  cy: number;
  startedAt: number;
}

export interface Death {
  playerId: string;
  x: number; // world px center
  y: number;
  at: number;
}

export interface Pickup {
  cx: number;
  cy: number;
  kind: PowerupKind;
  at: number;
}

export const CRUMBLE_MS = 400;
export const FLASH_MS = 120;
export const DEATH_SPIN_MS = 600;
export const DEATH_POP_MS = 250;
export const GHOST_MS = 900;
export const PICKUP_MS = 500;
export const SHAKE_MS = 140;

export class Fx {
  particles: Particle[] = [];
  crumbles: Crumble[] = [];
  deaths: Death[] = [];
  pickups: Pickup[] = [];
  shakeUntil = 0;
  /** Arena width in tiles (for decoding grid-string diffs); set per room. */
  gridWidth = ROOM_SIZE_GRID[DEFAULT_ROOM_SIZE_DESKTOP].width;

  private prev: SnapshotMessage | null = null;
  private lastFuseSpark = 0;
  private lastSparkle = 0;

  /** Forget everything (new round / new room). */
  reset(): void {
    this.particles = [];
    this.crumbles = [];
    this.deaths = [];
    this.pickups = [];
    this.shakeUntil = 0;
    this.prev = null;
  }

  /**
   * Diff the newest snapshot against the previous one and spawn effects.
   * Call reset() on round transitions so a fresh map doesn't read as
   * hundreds of crates crumbling.
   */
  process(snap: SnapshotMessage): void {
    const prev = this.prev;
    if (prev && snap.tick > prev.tick) this.diff(prev, snap);
    this.prev = snap;
  }

  private diff(prev: SnapshotMessage, snap: SnapshotMessage): void {
    const now = snap.serverTime;

    // Crates destroyed -> crumble + splinters.
    for (let i = 0; i < snap.grid.length; i++) {
      if (prev.grid[i] === 'C' && snap.grid[i] !== 'C') {
        const cx = i % this.gridWidth;
        const cy = Math.floor(i / this.gridWidth);
        this.crumbles.push({ cx, cy, startedAt: now });
        this.burst(cx * 16 + 8, cy * 16 + 8, now, [4, 4, 2, 15], 6, true);
      }
      // Crush block landed -> impact shake + dust.
      if (prev.grid[i] !== 'X' && snap.grid[i] === 'X') {
        const cx = i % this.gridWidth;
        const cy = Math.floor(i / this.gridWidth);
        this.shakeUntil = Math.max(this.shakeUntil, now + SHAKE_MS);
        this.burst(cx * 16 + 8, cy * 16 + 12, now, [5, 6, 13], 6, true);
      }
    }

    // New explosions -> shake + debris.
    for (const e of snap.explosions) {
      if (!prev.explosions.some((pe) => pe.id === e.id)) {
        this.shakeUntil = Math.max(this.shakeUntil, now + SHAKE_MS);
        for (const cell of e.cells.slice(0, 12)) {
          this.burst(cell.x * 16 + 8, cell.y * 16 + 8, now, [9, 10, 8], 2, false);
        }
      }
    }

    // Deaths -> spin/pop/ghost animation at last position.
    for (const p of snap.players) {
      const was = prev.players.find((pp) => pp.id === p.id);
      if (was?.alive && !p.alive) {
        this.deaths.push({ playerId: p.id, x: p.x * 16, y: p.y * 16, at: now });
      }
    }

    // Powerups gone -> picked up (player on the tile) or burned.
    for (const u of prev.powerups) {
      if (!snap.powerups.some((su) => su.id === u.id)) {
        const grabbed = snap.players.some(
          (p) => p.alive && Math.floor(p.x) === u.x && Math.floor(p.y) === u.y,
        );
        if (grabbed) {
          this.pickups.push({ cx: u.x, cy: u.y, kind: u.kind, at: now });
          this.burst(u.x * 16 + 8, u.y * 16 + 8, now, [10, 7, 14], 8, false);
        } else {
          this.burst(u.x * 16 + 8, u.y * 16 + 8, now, [5, 6], 4, false);
        }
      }
    }
  }

  /** Ambient effects that depend on current state, called each frame. */
  ambient(snap: SnapshotMessage, now: number): void {
    // Bomb fuse sparks.
    if (now - this.lastFuseSpark > 90 && snap.bombs.length > 0) {
      this.lastFuseSpark = now;
      for (const b of snap.bombs) {
        this.particles.push({
          x: b.x * 16 + 10,
          y: b.y * 16 + 1,
          vx: (this.rand(b.id.length + now) - 0.5) * 30,
          vy: -25,
          bornAt: now,
          lifeMs: 220,
          colorIdx: this.rand(now) > 0.5 ? 10 : 9,
          size: 1,
          gravity: false,
        });
      }
    }
    // Powerup sparkles, occasionally.
    if (now - this.lastSparkle > 700 && snap.powerups.length > 0) {
      this.lastSparkle = now;
      const u = snap.powerups[Math.floor(this.rand(now) * snap.powerups.length)];
      if (u) {
        this.particles.push({
          x: u.x * 16 + 2 + this.rand(now + 1) * 12,
          y: u.y * 16 + 2 + this.rand(now + 2) * 10,
          vx: 0,
          vy: -8,
          bornAt: now,
          lifeMs: 400,
          colorIdx: 7,
          size: 1,
          gravity: false,
        });
      }
    }
  }

  private burst(
    px: number,
    py: number,
    now: number,
    colors: number[],
    count: number,
    gravity: boolean,
  ): void {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + this.rand(now + i);
      const speed = 25 + this.rand(now + i * 7) * 45;
      this.particles.push({
        x: px,
        y: py,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - (gravity ? 30 : 0),
        bornAt: now,
        lifeMs: 350 + this.rand(now + i * 13) * 250,
        colorIdx: colors[i % colors.length] ?? 7,
        size: this.rand(now + i * 3) > 0.6 ? 2 : 1,
        gravity,
      });
    }
  }

  /** Advance + prune everything against the server clock. */
  update(now: number, dtMs: number): void {
    const dt = dtMs / 1000;
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.gravity) p.vy += 160 * dt;
    }
    this.particles = this.particles.filter((p) => now - p.bornAt < p.lifeMs);
    this.crumbles = this.crumbles.filter((c) => now - c.startedAt < CRUMBLE_MS);
    this.deaths = this.deaths.filter(
      (d) => now - d.at < DEATH_SPIN_MS + DEATH_POP_MS + GHOST_MS,
    );
    this.pickups = this.pickups.filter((p) => now - p.at < PICKUP_MS);
  }

  /** Integer shake offset, 1-2px max amplitude. */
  shakeOffset(now: number): [number, number] {
    if (now >= this.shakeUntil) return [0, 0];
    const phase = Math.floor(now / 30);
    const amp = this.shakeUntil - now > SHAKE_MS / 2 ? 2 : 1;
    return [((phase % 3) - 1) * amp, (((phase + 1) % 3) - 1) * amp];
  }

  /** Cheap deterministic pseudo-random in [0,1) — visual only. */
  private rand(seed: number): number {
    const s = Math.sin(seed * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  }
}
