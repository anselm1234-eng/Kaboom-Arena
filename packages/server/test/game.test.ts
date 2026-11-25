import { describe, expect, it } from 'vitest';
import {
  BOMB_FUSE_MS,
  PLAYER_RADIUS,
  ROOM_SIZES,
  ROOM_SIZE_GRID,
  TILE_CRATE,
  TILE_CRUSH,
  TILE_EMPTY,
  TILE_WALL,
  spawnPoints,
  type RoomSize,
} from '@blastmates/shared';
import { Game } from '../src/game';

// Most tests run on a 6-player room (15x13), matching the classic arena.
const SIZE: RoomSize = 6;
const W = ROOM_SIZE_GRID[SIZE].width;
const H = ROOM_SIZE_GRID[SIZE].height;
const ti = (x: number, y: number): number => y * W + x;

function emptyGrid(): Uint8Array {
  return new Uint8Array(W * H);
}

/** Advance the game in server-sized 50ms ticks. */
function run(game: Game, fromMs: number, toMs: number, stepMs = 50): void {
  for (let t = fromMs + stepMs; t <= toMs; t += stepMs) {
    game.update(t, stepMs);
  }
}

function cells(game: Game): Array<{ x: number; y: number }> {
  return game.explosions.flatMap((e) => e.cells);
}

function hasCell(game: Game, x: number, y: number): boolean {
  return cells(game).some((c) => c.x === x && c.y === y);
}

describe('movement and collision', () => {
  it('moves a player through open space at its speed', () => {
    const game = new Game(['a'], { size: SIZE, grid: emptyGrid() });
    game.setInput('a', 'right');
    run(game, 0, 1000);
    const p = game.players.get('a')!;
    expect(p.x).toBeCloseTo(3.5, 1);
    expect(p.y).toBeCloseTo(0.5, 5);
  });

  it('stops at indestructible walls', () => {
    const grid = emptyGrid();
    grid[ti(2, 0)] = TILE_WALL;
    const game = new Game(['a'], { size: SIZE, grid });
    game.setInput('a', 'right');
    run(game, 0, 2000);
    const p = game.players.get('a')!;
    expect(p.x).toBeCloseTo(2 - PLAYER_RADIUS, 5);
  });

  it('stops at crates', () => {
    const grid = emptyGrid();
    grid[ti(0, 2)] = TILE_CRATE;
    const game = new Game(['a'], { size: SIZE, grid });
    game.setInput('a', 'down');
    run(game, 0, 2000);
    const p = game.players.get('a')!;
    expect(p.y).toBeCloseTo(2 - PLAYER_RADIUS, 5);
  });

  it('cannot leave the grid bounds', () => {
    const game = new Game(['a'], { size: SIZE, grid: emptyGrid() });
    game.setInput('a', 'left');
    run(game, 0, 1000);
    const p = game.players.get('a')!;
    expect(p.x).toBeCloseTo(PLAYER_RADIUS, 5);
  });

  it('does not tunnel through walls on a large dt', () => {
    const grid = emptyGrid();
    grid[ti(2, 0)] = TILE_WALL;
    const game = new Game(['a'], { size: SIZE, grid });
    game.setInput('a', 'right');
    game.update(1000, 1000); // one giant 1s step
    const p = game.players.get('a')!;
    expect(p.x).toBeLessThanOrEqual(2 - PLAYER_RADIUS + 1e-9);
  });

  it('steers a blocked turn around the corner when leaning into the open lane', () => {
    const grid = emptyGrid();
    grid[ti(3, 1)] = TILE_WALL; // turning down from (3,0) is blocked...
    const game = new Game(['a'], { size: SIZE, grid });
    const a = game.players.get('a')!;
    a.x = 3.9; // ...but the player is mostly over (4,0), whose lane is open
    a.y = 0.5;
    game.setInput('a', 'down');
    run(game, 0, 1000);
    expect(a.x).toBeCloseTo(4.5, 5);
    expect(a.y).toBeGreaterThan(1.5);
  });

  it('does not assist a blocked turn when nearly centred on the blocked lane', () => {
    const grid = emptyGrid();
    grid[ti(3, 1)] = TILE_WALL;
    const game = new Game(['a'], { size: SIZE, grid });
    const a = game.players.get('a')!;
    a.x = 3.55; // offset 0.05: well inside the lane, the wall ahead is meant
    a.y = 0.5;
    game.setInput('a', 'down');
    run(game, 0, 1000);
    expect(a.x).toBeCloseTo(3.5, 5);
    expect(a.y).toBeCloseTo(1 - PLAYER_RADIUS, 5);
  });

  it('does not assist into a lane that is itself blocked', () => {
    const grid = emptyGrid();
    grid[ti(3, 1)] = TILE_WALL;
    grid[ti(4, 1)] = TILE_WALL; // the neighbouring lane is no better
    const game = new Game(['a'], { size: SIZE, grid });
    const a = game.players.get('a')!;
    a.x = 3.9;
    a.y = 0.5;
    game.setInput('a', 'down');
    run(game, 0, 1000);
    expect(a.x).toBeCloseTo(3.5, 5);
    expect(a.y).toBeCloseTo(1 - PLAYER_RADIUS, 5);
  });

  it('assists horizontal movement around a corner too', () => {
    const grid = emptyGrid();
    grid[ti(3, 0)] = TILE_WALL; // moving right along row 0 is blocked...
    const game = new Game(['a'], { size: SIZE, grid });
    const a = game.players.get('a')!;
    a.x = 2.5;
    a.y = 0.9; // ...but the player is leaning into the open row 1
    game.setInput('a', 'right');
    run(game, 0, 1500);
    expect(a.y).toBeCloseTo(1.5, 5);
    expect(a.x).toBeGreaterThan(3.5);
  });

  it('blocks other players with a bomb but lets the placer walk off it', () => {
    const grid = emptyGrid();
    const game = new Game(['a', 'b'], { size: SIZE, grid });
    const a = game.players.get('a')!;
    const b = game.players.get('b')!;
    b.x = 3.5;
    b.y = 0.5;
    expect(game.placeBomb('a', 0)).toBe(true);

    // Placer escapes to the right.
    game.setInput('a', 'right');
    run(game, 0, 500);
    expect(a.x).toBeGreaterThan(1);

    // Other player walking left is blocked by the bomb at (0,0).
    game.setInput('b', 'left');
    run(game, 500, 2000);
    expect(b.x).toBeCloseTo(1 + PLAYER_RADIUS, 5);
  });
});

describe('bombs and explosions', () => {
  it('enforces the concurrent bomb cap', () => {
    const game = new Game(['a'], { size: SIZE, grid: emptyGrid() });
    expect(game.placeBomb('a', 0)).toBe(true);
    const a = game.players.get('a')!;
    a.x = 2.5; // pretend they walked away
    expect(game.placeBomb('a', 0)).toBe(false); // cap = 1
    a.bombCap = 2;
    expect(game.placeBomb('a', 0)).toBe(true);
  });

  it('rejects a second bomb on the same tile', () => {
    const game = new Game(['a'], { size: SIZE, grid: emptyGrid() });
    const a = game.players.get('a')!;
    a.bombCap = 3;
    expect(game.placeBomb('a', 0)).toBe(true);
    expect(game.placeBomb('a', 0)).toBe(false);
  });

  it('explodes in a cross stopped by walls and absorbs into crates', () => {
    const grid = emptyGrid();
    grid[ti(2, 0)] = TILE_WALL; // blocks the right ray at distance 2
    grid[ti(0, 1)] = TILE_CRATE; // absorbs the down ray at distance 1
    const game = new Game(['a'], { size: SIZE, grid, rng: () => 0.99 }); // no powerup drops
    expect(game.placeBomb('a', 0)).toBe(true);
    game.update(BOMB_FUSE_MS, 50);

    expect(game.bombs).toHaveLength(0);
    expect(hasCell(game, 0, 0)).toBe(true); // centre
    expect(hasCell(game, 1, 0)).toBe(true); // right, range 1
    expect(hasCell(game, 2, 0)).toBe(false); // wall blocks
    expect(hasCell(game, 0, 1)).toBe(true); // crate cell burns
    expect(hasCell(game, 0, 2)).toBe(false); // ray stopped by crate
    expect(game.grid[ti(0, 1)]).toBe(TILE_EMPTY); // crate destroyed
    expect(game.grid[ti(2, 0)]).toBe(TILE_WALL); // wall survives
  });

  it('chain-detonates bombs caught in a blast', () => {
    const game = new Game(['a'], { size: SIZE, grid: emptyGrid(), rng: () => 0.99 });
    const a = game.players.get('a')!;
    a.bombCap = 2;
    expect(game.placeBomb('a', 0)).toBe(true); // at (0,0), explodes at 3000
    a.x = 2.5;
    expect(game.placeBomb('a', 1000)).toBe(true); // at (2,0), would explode at 4000
    a.y = 8.5; // move out of harm's way

    game.update(BOMB_FUSE_MS, 50); // first fuse expires -> chain
    expect(game.bombs).toHaveLength(0); // both gone
    // Second bomb's own cross fired from (2,0): reaches (4,0).
    expect(hasCell(game, 4, 0)).toBe(true);
    expect(hasCell(game, 2, 2)).toBe(true);
  });

  it('kills players standing in the blast', () => {
    const game = new Game(['a', 'b'], { size: SIZE, grid: emptyGrid() });
    const b = game.players.get('b')!;
    b.x = 2.5; // within range-2 of a bomb at (0,0)
    b.y = 0.5;
    game.placeBomb('a', 0);
    game.update(BOMB_FUSE_MS, 50);
    expect(game.players.get('a')!.alive).toBe(false); // placer stood on it
    expect(b.alive).toBe(false);
    expect(game.alivePlayers()).toHaveLength(0);
  });

  it('kills players who walk into lingering flames', () => {
    const game = new Game(['a', 'b'], { size: SIZE, grid: emptyGrid() });
    const b = game.players.get('b')!;
    b.x = 4.5;
    b.y = 0.5;
    game.placeBomb('a', 0);
    game.update(BOMB_FUSE_MS, 50);
    expect(b.alive).toBe(true);
    b.x = 1.5; // steps into the flame cells while they linger
    game.update(BOMB_FUSE_MS + 100, 50);
    expect(b.alive).toBe(false);
  });
});

describe('powerups', () => {
  it('drops a powerup from a destroyed crate when rng allows', () => {
    const grid = emptyGrid();
    grid[ti(1, 0)] = TILE_CRATE;
    const game = new Game(['a'], { size: SIZE, grid, rng: () => 0 }); // always drop, kind = bomb
    game.placeBomb('a', 0);
    game.update(BOMB_FUSE_MS, 50);
    expect(game.powerups).toHaveLength(1);
    expect(game.powerups[0]).toMatchObject({ cx: 1, cy: 0, kind: 'bomb' });
  });

  it('does not drop powerups when rng is above the drop chance', () => {
    const grid = emptyGrid();
    grid[ti(1, 0)] = TILE_CRATE;
    const game = new Game(['a'], { size: SIZE, grid, rng: () => 0.99 });
    game.placeBomb('a', 0);
    game.update(BOMB_FUSE_MS, 50);
    expect(game.powerups).toHaveLength(0);
  });

  it('applies pickups and removes them from the field', () => {
    const game = new Game(['a'], { size: SIZE, grid: emptyGrid() });
    const a = game.players.get('a')!;
    game.powerups.push(
      { id: 'u1', cx: 0, cy: 0, kind: 'range' },
      { id: 'u2', cx: 1, cy: 0, kind: 'speed' },
      { id: 'u3', cx: 2, cy: 0, kind: 'bomb' },
    );
    game.setInput('a', 'right');
    run(game, 0, 1000);
    expect(a.range).toBe(3);
    expect(a.speed).toBeCloseTo(3.5, 5);
    expect(a.bombCap).toBe(2);
    expect(game.powerups).toHaveLength(0);
  });

  it('destroys exposed powerups caught in a later blast', () => {
    const game = new Game(['a'], { size: SIZE, grid: emptyGrid(), rng: () => 0.99 });
    game.powerups.push({ id: 'u1', cx: 1, cy: 0, kind: 'range' });
    game.placeBomb('a', 0);
    game.update(BOMB_FUSE_MS, 50);
    expect(game.powerups).toHaveLength(0);
  });
});

describe('spawns', () => {
  it.each(ROOM_SIZES.map((s) => [s] as [RoomSize]))(
    'assigns players to the symmetric spawn points of a %i-player room, in order',
    (size) => {
      const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].slice(0, size);
      const game = new Game(ids, { size });
      const expected = spawnPoints(size);
      expect(expected).toHaveLength(size);
      ids.forEach((id, i) => {
        const p = game.players.get(id)!;
        expect({ x: p.x, y: p.y }).toEqual({ x: expected[i]!.x + 0.5, y: expected[i]!.y + 0.5 });
      });
    },
  );

  it('seats no more players than the room size has spawn points', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const game = new Game(ids, { size: 4 });
    expect(game.players.size).toBe(4);
  });
});

describe('sudden death', () => {
  // First block: start (0) + afterMs (1000) + warningMs (200) = 1200,
  // then one every 100ms following the spiral from (0,0) clockwise.
  const SD = { afterMs: 1000, intervalMs: 100, warningMs: 200 };

  function sdGame(ids: string[] = ['a', 'b']): Game {
    const game = new Game(ids, { size: SIZE, grid: emptyGrid(), suddenDeath: SD });
    game.update(0, 50); // pin the round start (and so the schedule) to t=0
    return game;
  }

  it('exposes the scheduled start time once the round is running', () => {
    const game = sdGame();
    expect(game.suddenDeathAt).toBe(1000);
  });

  it('does nothing before the configured start time', () => {
    const game = sdGame();
    run(game, 0, 950);
    expect(game.crushWarnings(950)).toEqual([]);
    expect([...game.grid]).not.toContain(TILE_CRUSH);
  });

  it('telegraphs each tile warningMs before the block lands', () => {
    const game = sdGame();
    run(game, 0, 1050);
    const warnings = game.crushWarnings(1050);
    expect(warnings[0]).toEqual({ x: 0, y: 0, landsAt: 1200 });
    expect(game.grid[ti(0, 0)]).toBe(TILE_EMPTY); // not landed yet
  });

  it('crushes a player standing on the tile via the normal death pipeline', () => {
    const game = sdGame(); // 'a' spawns at (0,0), the first spiral cell
    run(game, 0, 1250);
    expect(game.grid[ti(0, 0)]).toBe(TILE_CRUSH);
    expect(game.players.get('a')!.alive).toBe(false);
    expect(game.players.get('b')!.alive).toBe(true);
  });

  it('removes a crushed bomb without exploding it', () => {
    const game = sdGame();
    game.placeBomb('a', 0); // fuse would run until t=3000
    const a = game.players.get('a')!;
    a.x = 5.5; // step off the doomed corner
    a.y = 6.5;
    run(game, 0, 1250);
    expect(game.bombs).toHaveLength(0);
    run(game, 1250, 3500); // past the original fuse: still no blast
    expect(game.explosions).toHaveLength(0);
    expect(game.grid[ti(0, 0)]).toBe(TILE_CRUSH);
  });

  it('removes a powerup under a landing block', () => {
    const game = sdGame();
    game.powerups.push({ id: 'u1', cx: 1, cy: 0, kind: 'range' });
    run(game, 0, 1350); // (1,0) is the second spiral cell, lands at 1300
    expect(game.powerups).toHaveLength(0);
  });

  it('replaces a crate with a permanent crush wall, dropping no powerup', () => {
    const game = sdGame();
    game.grid[ti(2, 0)] = TILE_CRATE;
    run(game, 0, 1450); // (2,0) lands at 1400
    expect(game.grid[ti(2, 0)]).toBe(TILE_CRUSH);
    expect(game.powerups).toHaveLength(0);
  });

  it('stops the spiral at the central 3x3 safe area', () => {
    const game = sdGame();
    run(game, 0, 17_000); // far past the last scheduled landing
    expect(game.crushWarnings(17_000)).toEqual([]);
    const cx = (W - 1) >> 1;
    const cy = (H - 1) >> 1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inSafeArea = Math.abs(x - cx) <= 1 && Math.abs(y - cy) <= 1;
        const pillar = x % 2 === 1 && y % 2 === 1;
        const want = inSafeArea || pillar ? TILE_EMPTY : TILE_CRUSH;
        expect(game.grid[ti(x, y)]).toBe(want);
      }
    }
  });

  it.each(ROOM_SIZES.map((s) => [s] as [RoomSize]))(
    'closes to the central safe area on a %i-player map',
    (size) => {
      const { width, height } = ROOM_SIZE_GRID[size];
      const game = new Game(['a', 'b'], {
        size,
        grid: new Uint8Array(width * height),
        suddenDeath: SD,
      });
      // Park both players inside the safe center so the shrink completes.
      for (const id of ['a', 'b'] as const) {
        const p = game.players.get(id)!;
        p.x = ((width - 1) >> 1) + 0.5;
        p.y = ((height - 1) >> 1) + 0.5;
      }
      game.update(0, 50);
      run(game, 0, 30_000); // far past the last scheduled landing on any size
      expect(game.crushWarnings(30_000)).toEqual([]);
      const cx = (width - 1) >> 1;
      const cy = (height - 1) >> 1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const inSafeArea = Math.abs(x - cx) <= 1 && Math.abs(y - cy) <= 1;
          const pillar = x % 2 === 1 && y % 2 === 1;
          const want = inSafeArea || pillar ? TILE_EMPTY : TILE_CRUSH;
          expect(game.grid[y * width + x]).toBe(want);
        }
      }
    },
  );

  it('never starts while fewer than two players are alive', () => {
    const game = sdGame();
    game.killPlayer('b'); // the room would end the round; the shrink must not begin
    run(game, 0, 3000);
    expect(game.crushWarnings(3000)).toEqual([]);
    expect([...game.grid]).not.toContain(TILE_CRUSH);
  });

  it('lands on a dead player\'s tile without errors', () => {
    const game = sdGame(['a', 'b', 'c']);
    game.killPlayer('a'); // corpse stays on (0,0)
    const b = game.players.get('b')!;
    b.x = 6.5;
    b.y = 6.5;
    const c = game.players.get('c')!;
    c.x = 8.5;
    c.y = 6.5;
    run(game, 0, 1300);
    expect(game.grid[ti(0, 0)]).toBe(TILE_CRUSH);
    expect(game.players.get('b')!.alive).toBe(true);
    expect(game.players.get('c')!.alive).toBe(true);
  });

  it('blocks movement through landed crush walls', () => {
    const game = sdGame();
    const a = game.players.get('a')!;
    a.x = 0.5;
    a.y = 2.5; // below the corner, off the first ring's early cells
    run(game, 0, 1250); // (0,0) has landed
    game.setInput('a', 'up');
    run(game, 1250, 2500); // plenty of time to walk into the new wall
    expect(game.players.get('a')!.alive).toBe(true);
    expect(game.players.get('a')!.y).toBeCloseTo(1 + PLAYER_RADIUS, 5);
  });
});
