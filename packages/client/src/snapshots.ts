import { INTERP_DELAY_MS, type PlayerSnapshot, type SnapshotMessage } from '@blastmates/shared';

export interface RenderView {
  /** Latest snapshot: grid, bombs, explosions, powerups, authoritative stats. */
  base: SnapshotMessage;
  /** Player positions interpolated ~INTERP_DELAY_MS behind server time. */
  players: PlayerSnapshot[];
}

/**
 * Buffers 20Hz server snapshots and lets the 60fps render loop sample
 * smoothly interpolated player positions slightly in the past.
 */
export class SnapshotBuffer {
  private snaps: SnapshotMessage[] = [];
  private offset: number | null = null; // serverTime - performance.now()

  push(snap: SnapshotMessage): void {
    // Bricks are sent only on keyframes; non-keyframe ticks omit them and we
    // carry the last known set forward so every buffered snapshot is complete.
    if (snap.bricks === undefined) {
      const prev = this.snaps[this.snaps.length - 1];
      snap = { ...snap, bricks: prev?.bricks ?? [] };
    }
    this.snaps.push(snap);
    if (this.snaps.length > 40) this.snaps.splice(0, this.snaps.length - 40);
    this.noteServerTime(snap.serverTime);
  }

  noteServerTime(serverTime: number): void {
    const sample = serverTime - performance.now();
    // Light smoothing; jumps (reconnect, GC pause) snap immediately.
    this.offset =
      this.offset === null || Math.abs(sample - this.offset) > 500
        ? sample
        : this.offset * 0.9 + sample * 0.1;
  }

  clear(): void {
    this.snaps = [];
  }

  get hasData(): boolean {
    return this.snaps.length > 0;
  }

  latest(): SnapshotMessage | null {
    return this.snaps[this.snaps.length - 1] ?? null;
  }

  /** Estimated current time on the server clock. */
  serverNow(): number {
    return this.offset === null ? 0 : performance.now() + this.offset;
  }

  sample(): RenderView | null {
    const latest = this.snaps[this.snaps.length - 1];
    if (!latest) return null;
    const renderTime = this.serverNow() - INTERP_DELAY_MS;

    let older = latest;
    let newer = latest;
    for (let i = this.snaps.length - 1; i >= 0; i--) {
      const s = this.snaps[i];
      if (!s) continue;
      if (s.serverTime <= renderTime) {
        older = s;
        newer = this.snaps[i + 1] ?? s;
        break;
      }
      newer = s;
      older = s;
    }

    const span = newer.serverTime - older.serverTime;
    const t = span > 0 ? Math.min(Math.max((renderTime - older.serverTime) / span, 0), 1) : 1;

    const players = newer.players.map((np) => {
      const op = older.players.find((p) => p.id === np.id) ?? np;
      return { ...np, x: op.x + (np.x - op.x) * t, y: op.y + (np.y - op.y) * t };
    });

    return { base: latest, players };
  }
}
