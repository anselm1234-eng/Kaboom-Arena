import type { SnapshotMessage } from '@blastmates/shared';
import { audio } from './sound';

/**
 * Derives the audible game moments by diffing snapshots, mirroring how Fx
 * derives visuals and HapticEvents derives vibration - no extra netcode.
 * Sounds caused by this device's players ("own") play louder than the rest
 * so a busy 8-player room stays readable.
 */
export class SoundEvents {
  private prevTick: number | null = null;
  private prevBombs = new Set<string>();
  private prevMyBombs = new Set<string>();
  private prevExplosions = new Set<string>();
  private prevAlive = new Map<string, boolean>();
  private prevGrid: string | null = null;
  private prevPowerups: SnapshotMessage['powerups'] = [];
  private prevServerTime: number | null = null;

  reset(): void {
    this.prevTick = null;
    this.prevBombs = new Set();
    this.prevMyBombs = new Set();
    this.prevExplosions = new Set();
    this.prevAlive = new Map();
    this.prevGrid = null;
    this.prevPowerups = [];
    this.prevServerTime = null;
    audio.setSuddenDeath(false);
  }

  processSnapshot(snap: SnapshotMessage, myIds: string[]): void {
    const mine = new Set(myIds);
    const bombs = new Set<string>();
    const myBombs = new Set<string>();
    for (const b of snap.bombs) {
      bombs.add(b.id);
      if (mine.has(b.ownerId)) myBombs.add(b.id);
    }
    const explosions = new Set<string>();
    for (const e of snap.explosions) explosions.add(e.id);

    if (this.prevTick !== null && snap.tick > this.prevTick) {
      this.diff(snap, mine, bombs, explosions);
    }

    this.prevServerTime = snap.serverTime;
    this.prevTick = snap.tick;
    this.prevBombs = bombs;
    this.prevMyBombs = myBombs;
    this.prevExplosions = explosions;
    this.prevGrid = snap.grid;
    this.prevPowerups = snap.powerups;
    this.prevAlive = new Map(snap.players.map((p) => [p.id, p.alive]));
  }

  private diff(
    snap: SnapshotMessage,
    mine: Set<string>,
    bombs: Set<string>,
    explosions: Set<string>,
  ): void {
    // Bombs placed; at most one sound per tick, own takes precedence.
    let placed: boolean | null = null;
    for (const b of snap.bombs) {
      if (!this.prevBombs.has(b.id)) placed = placed === true || mine.has(b.ownerId);
    }
    if (placed !== null) audio.bombPlaced(placed);

    // New explosions; "own" when one of our bombs vanished this tick.
    const ownExploded = [...this.prevMyBombs].some((id) => !bombs.has(id));
    if ([...explosions].some((id) => !this.prevExplosions.has(id))) {
      audio.explosion(ownExploded);
    }

    // Crates destroyed / crush blocks landed (one sound each per tick).
    if (this.prevGrid !== null) {
      let crate = false;
      let crush = false;
      for (let i = 0; i < snap.grid.length; i++) {
        if (this.prevGrid[i] === 'C' && snap.grid[i] !== 'C') crate = true;
        if (this.prevGrid[i] !== 'X' && snap.grid[i] === 'X') crush = true;
      }
      if (crate) audio.crateBroken();
      if (crush) audio.crushLanded();
    }

    // Deaths; an own death must cut through everything else.
    for (const p of snap.players) {
      if (this.prevAlive.get(p.id) === true && !p.alive) audio.death(mine.has(p.id));
    }

    // Powerups picked up (vanished with a live player on the tile, like Fx).
    for (const u of this.prevPowerups) {
      if (!snap.powerups.some((su) => su.id === u.id)) {
        const grabber = snap.players.find(
          (p) => p.alive && Math.floor(p.x) === u.x && Math.floor(p.y) === u.y,
        );
        if (grabber) audio.pickup(mine.has(grabber.id));
      }
    }

    // Sudden death begins: alarm + faster music.
    if (
      snap.suddenDeathAt !== undefined &&
      this.prevServerTime !== null &&
      this.prevServerTime < snap.suddenDeathAt &&
      snap.serverTime >= snap.suddenDeathAt
    ) {
      audio.suddenDeathAlarm();
      audio.setSuddenDeath(true);
    }
  }
}
