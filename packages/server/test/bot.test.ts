import { describe, expect, it } from 'vitest';
import {
  BOMB_FUSE_MS,
  DEFAULT_RANGE,
  EXPLOSION_DURATION_MS,
  PREMATCH_COUNTDOWN_MS,
  ROOM_MAX_PLAYERS,
  ROOM_SIZE_GRID,
  TICK_MS,
  TILE_CRATE,
  TILE_EMPTY,
  TILE_WALL,
  generateMap,
  mulberry32,
  type Direction,
  type RoomSize,
  type ServerMessage,
} from '@blastmates/shared';
import { BOT_NAMES, BotController } from '../src/bot';
import { Game } from '../src/game';
import { Room, RoomError, type ClientConn } from '../src/room';

class FakeConn implements ClientConn {
  msgs: ServerMessage[] = [];
  send(msg: ServerMessage): void {
    this.msgs.push(msg);
  }
}

function publicRoom(onEmpty?: (room: Room) => void): Room {
  return new Room('test01', false, undefined, { rng: mulberry32(3), ...(onEmpty ? { onEmpty } : {}) });
}

function privateRoom(): Room {
  return new Room('priv01', true, undefined, { rng: mulberry32(3) });
}

/** Host start + the pre-match countdown; the round goes live exactly at `now`. */
function hostStart(room: Room, hostId: string, now: number): void {
  room.startByHost(hostId, now - PREMATCH_COUNTDOWN_MS);
  room.tick(now);
}

describe('bot roster management', () => {
  it('private rooms: the host adds bots; non-hosts are rejected', () => {
    const room = privateRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 100);

    expect(() => room.addBot(bob.id, 200)).toThrowError(
      expect.objectContaining({ code: 'not_host' }),
    );
    expect(room.roster.size).toBe(2);

    const bot = room.addBot(alice.id, 300);
    expect(bot.bot).toBe(true);
    expect(room.roster.size).toBe(3);
  });

  it('private rooms: only the host removes bots; removal works in the lobby', () => {
    const room = privateRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 100);
    const bot = room.addBot(alice.id, 200);

    expect(() => room.removeBot(bob.id, bot.id, 300)).toThrowError(
      expect.objectContaining({ code: 'not_host' }),
    );
    expect(room.roster.has(bot.id)).toBe(true);

    room.removeBot(alice.id, bot.id, 400);
    expect(room.roster.has(bot.id)).toBe(false);
  });

  it('refuses to remove humans through removeBot', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 100);
    expect(() => room.removeBot(alice.id, bob.id, 200)).toThrowError(
      expect.objectContaining({ code: 'no_such_bot' }),
    );
    expect(room.roster.has(bob.id)).toBe(true);
  });

  it('bots occupy normal slots and respect the max player count', () => {
    const room = privateRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    for (let i = 1; i < ROOM_MAX_PLAYERS; i++) room.addBot(alice.id, i * 100);
    expect(() => room.addBot(alice.id, ROOM_MAX_PLAYERS * 100)).toThrowError(
      expect.objectContaining({ code: 'room_full' }),
    );
  });

  it('assigns bot names from the pool without duplicates', () => {
    const room = privateRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const names = [room.addBot(alice.id, 1), room.addBot(alice.id, 2), room.addBot(alice.id, 3)].map(
      (b) => b.nickname,
    );
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(BOT_NAMES).toContain(name);
  });

  it('marks bots in the room message sent to clients', () => {
    const room = publicRoom();
    const conn = new FakeConn();
    const alice = room.addPlayer('alice', conn, 0);
    const bot = room.addBot(alice.id, 100);
    const msg = room.roomMessage(200);
    if (msg.t !== 'room') throw new Error('expected room message');
    expect(msg.players.find((p) => p.id === bot.id)?.bot).toBe(true);
    expect(msg.players.find((p) => p.id === bot.id)?.ready).toBe(true); // always ready
    expect(msg.players.find((p) => p.id === alice.id)?.bot).toBeUndefined();
  });

  it('counts bots toward the minimum player count for starting', () => {
    const room = privateRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    expect(() => room.startByHost(alice.id, 100)).toThrow(RoomError); // alone
    room.addBot(alice.id, 200);
    hostStart(room, alice.id, 300);
    expect(room.state).toBe('playing');
    expect(room.game!.players.size).toBe(2);
  });

  it('cannot add bots once the game is playing', () => {
    const room = privateRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    room.addBot(alice.id, 100);
    hostStart(room, alice.id, 200);
    expect(() => room.addBot(alice.id, 300)).toThrowError(
      expect.objectContaining({ code: 'cannot_start' }),
    );
  });

  it('never makes a bot host; on host leave the next human inherits bots', () => {
    const room = privateRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bot = room.addBot(alice.id, 100); // bot joins before bob
    const bob = room.addPlayer('bob', new FakeConn(), 200);

    room.handleDisconnect(alice.id, 300);
    expect(room.hostId).toBe(bob.id); // skipped the earlier-joined bot
    expect(room.roster.has(bot.id)).toBe(true); // bots persist

    // The new host has full bot controls.
    const second = room.addBot(bob.id, 400);
    room.removeBot(bob.id, second.id, 500);
  });

  it('destroys the room when the last human leaves even if bots remain', () => {
    let emptied = false;
    const room = publicRoom(() => {
      emptied = true;
    });
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    room.addBot(alice.id, 100);
    room.removePlayer(alice.id, 200);
    expect(emptied).toBe(true);
  });

  it('removes a bot cleanly mid-game, like a disconnect', () => {
    const room = privateRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    room.addPlayer('bob', new FakeConn(), 100);
    const bot = room.addBot(alice.id, 200);
    hostStart(room, alice.id, 300);
    expect(room.game!.players.get(bot.id)!.alive).toBe(true);

    room.removeBot(alice.id, bot.id, 400);
    expect(room.roster.has(bot.id)).toBe(false);
    expect(room.game!.players.get(bot.id)!.alive).toBe(false);
    room.tick(450);
    expect(room.state).toBe('playing'); // two humans still fighting
  });
});

// --- Bot AI ---

// AI tests run on a 6-player room (15x13), matching the classic arena.
const SIZE: RoomSize = 6;
const W = ROOM_SIZE_GRID[SIZE].width;
const H = ROOM_SIZE_GRID[SIZE].height;
const ti = (x: number, y: number): number => y * W + x;

function emptyGrid(): Uint8Array {
  return new Uint8Array(W * H).fill(TILE_EMPTY);
}

/** Drive one bot through the same setInput/placeBomb pipeline for N ticks. */
function runTicks(game: Game, controller: BotController, ticks: number, startAt = 0): number {
  let now = startAt;
  for (let i = 0; i < ticks; i++) {
    now += TICK_MS;
    const decision = controller.update(game, now);
    game.setInput(controller.playerId, decision.dir);
    if (decision.bomb) game.placeBomb(controller.playerId, now);
    game.update(now, TICK_MS);
  }
  return now;
}

const FULL_BLAST_TICKS = Math.ceil((BOMB_FUSE_MS + EXPLOSION_DURATION_MS + 500) / TICK_MS);

describe('bot AI (normal)', () => {
  it('escapes the blast zone of a bomb on its own tile', () => {
    const game = new Game(['bot', 'foe'], { size: SIZE, grid: emptyGrid(), rng: mulberry32(7) });
    game.placeBomb('bot', 0);
    const controller = new BotController('bot', 'normal', mulberry32(11));
    runTicks(game, controller, FULL_BLAST_TICKS);
    expect(game.players.get('bot')!.alive).toBe(true);
    expect(game.bombs).toHaveLength(0); // it went off without the bot in it
  });

  it('never places a bomb when no escape exists', () => {
    const grid = emptyGrid();
    grid[ti(1, 0)] = TILE_CRATE;
    grid[ti(0, 1)] = TILE_CRATE; // bot sealed into its corner
    const game = new Game(['bot', 'foe'], { size: SIZE, grid, rng: mulberry32(7) });
    const controller = new BotController('bot', 'normal', mulberry32(11));
    runTicks(game, controller, 200);
    expect(game.bombs).toHaveLength(0);
    expect(game.players.get('bot')!.alive).toBe(true);
  });

  it('bombs a reachable crate and survives its own blast', () => {
    const grid = emptyGrid();
    grid[ti(2, 0)] = TILE_CRATE; // in range from spawn, escape via (1,1)
    const game = new Game(['bot', 'foe'], { size: SIZE, grid, rng: mulberry32(7) });
    const controller = new BotController('bot', 'normal', mulberry32(11));
    runTicks(game, controller, FULL_BLAST_TICKS * 2);
    expect(grid[ti(2, 0)]).toBe(TILE_EMPTY); // crate destroyed
    expect(game.players.get('bot')!.alive).toBe(true);
  });

  it('bombs an enemy caught in its blast line', () => {
    const game = new Game(['bot', 'foe'], { size: SIZE, grid: emptyGrid(), rng: mulberry32(7) });
    const foe = game.players.get('foe')!;
    foe.x = 0.5;
    foe.y = 2.5; // two tiles below the bot, clear line, within range 2
    const controller = new BotController('bot', 'normal', mulberry32(11));
    runTicks(game, controller, FULL_BLAST_TICKS * 2);
    expect(game.players.get('foe')!.alive).toBe(false);
    expect(game.players.get('bot')!.alive).toBe(true);
  });
});

describe('full match vs a bot', () => {
  it('plays a round end to end: host idles, bot hunts and wins', () => {
    const room = new Room('match1', true, undefined, { rng: mulberry32(5) });
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bot = room.addBot(alice.id, 100);
    hostStart(room, alice.id, 200);
    expect(room.state).toBe('playing');

    let now = 200;
    const maxTicks = Math.ceil((10 * 60 * 1000) / TICK_MS); // 10 in-game minutes
    for (let i = 0; i < maxTicks && room.state === 'playing'; i++) {
      now += TICK_MS;
      room.tick(now);
    }
    expect(room.state).toBe('roundEnd');
    expect(room.winnerId).toBe(bot.id); // idle human loses to the bot
    expect(room.roster.get(bot.id)!.wins).toBe(1);
  });
});

describe('bot sudden death awareness', () => {
  it('flees a tile scheduled to be crushed', () => {
    const game = new Game(['bot', 'foe'], {
      size: SIZE,
      grid: emptyGrid(),
      suddenDeath: { afterMs: 100, intervalMs: 100, warningMs: 300 },
    });
    game.players.get('foe')!.x = 7.5;
    game.players.get('foe')!.y = 6.5; // parked in the safe center
    game.update(0, TICK_MS); // round starts at t=0
    game.update(100, TICK_MS); // sudden death activates
    const controller = new BotController('bot', 'normal', mulberry32(11));
    const decision = controller.update(game, 150);
    // The whole top row is doomed soon; the only timely escape is down.
    expect(decision.dir).toBe('down');
  });

  it('retreats ahead of the spiral and survives in the safe area', () => {
    // Real arena shape: pillars on odd/odd cells (the spiral skips those, so
    // an empty grid would leave survivable holes that real maps never have).
    const grid = emptyGrid();
    for (let y = 1; y < H; y += 2) {
      for (let x = 1; x < W; x += 2) grid[ti(x, y)] = TILE_WALL;
    }
    const game = new Game(['bot', 'foe'], {
      size: SIZE,
      grid,
      rng: mulberry32(7),
      suddenDeath: { afterMs: 500, intervalMs: 150, warningMs: 450 },
    });
    game.players.get('foe')!.x = 7.5;
    game.players.get('foe')!.y = 6.5; // immobile target in the safe center
    const controller = new BotController('bot', 'normal', mulberry32(11));
    let now = 0;
    while (now < 26_000) {
      now += TICK_MS;
      const decision = controller.update(game, now);
      game.setInput('bot', decision.dir);
      if (decision.bomb) game.placeBomb('bot', now);
      game.update(now, TICK_MS);
    }
    const me = game.players.get('bot')!;
    expect(me.alive).toBe(true); // it outran the shrinking edge
    expect(Math.abs(Math.floor(me.x) - 7)).toBeLessThanOrEqual(1);
    expect(Math.abs(Math.floor(me.y) - 6)).toBeLessThanOrEqual(1);
  });
});

// --- Helpers shared by the hunting / difficulty suites ---

const OPPOSITE: Record<Direction, Direction> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
};

function manhattan(game: Game, a: string, b: string): number {
  const pa = game.players.get(a)!;
  const pb = game.players.get(b)!;
  return Math.abs(Math.floor(pa.x) - Math.floor(pb.x)) + Math.abs(Math.floor(pa.y) - Math.floor(pb.y));
}

/** Run several bots through one shared game until one survives or time runs out. */
function runMatch(
  game: Game,
  controllers: BotController[],
  maxTicks: number,
): { now: number; winner: string | null } {
  let now = 0;
  for (let i = 0; i < maxTicks; i++) {
    now += TICK_MS;
    for (const c of controllers) {
      if (!game.players.get(c.playerId)?.alive) continue;
      const d = c.update(game, now);
      game.setInput(c.playerId, d.dir);
      if (d.bomb) game.placeBomb(c.playerId, now);
    }
    game.update(now, TICK_MS);
    const alive = game.alivePlayers();
    if (alive.length <= 1) return { now, winner: alive[0]?.id ?? null };
  }
  return { now, winner: null };
}

describe('bot hunting & pursuit', () => {
  it('pursues a stationary enemy across an open lane and kills it', () => {
    const game = new Game(['bot', 'foe'], { size: SIZE, grid: emptyGrid(), rng: mulberry32(7) });
    const foe = game.players.get('foe')!;
    foe.x = 5.5;
    foe.y = 0.5; // same row, five tiles away — within engage range, no clear line yet
    const controller = new BotController('bot', 'normal', mulberry32(11));
    runTicks(game, controller, FULL_BLAST_TICKS * 3);
    expect(game.players.get('foe')!.alive).toBe(false); // hunted down
    expect(game.players.get('bot')!.alive).toBe(true);
  });

  it('closes the distance to a far enemy when nothing else is worth doing', () => {
    const game = new Game(['bot', 'foe'], { size: SIZE, grid: emptyGrid(), rng: mulberry32(7) });
    const foe = game.players.get('foe')!;
    foe.x = W - 1 + 0.5;
    foe.y = H - 1 + 0.5; // opposite corner, far outside engage range
    const controller = new BotController('bot', 'normal', mulberry32(3));
    const before = manhattan(game, 'bot', 'foe');
    runTicks(game, controller, 80);
    const after = manhattan(game, 'bot', 'foe');
    expect(after).toBeLessThan(before - 5); // it advanced, not drifted aimlessly
  });

  it('never freezes: always has a move when a safe neighbour exists', () => {
    const game = new Game(['bot', 'foe'], { size: SIZE, grid: emptyGrid(), rng: mulberry32(7) });
    game.players.get('foe')!.x = W - 1 + 0.5;
    game.players.get('foe')!.y = H - 1 + 0.5;
    const controller = new BotController('bot', 'normal', mulberry32(3));
    expect(controller.update(game, TICK_MS).dir).not.toBeNull();
  });
});

describe('bot navigation is stable (no wobble)', () => {
  it('walks a straight line to a powerup without reversing direction', () => {
    const game = new Game(['bot', 'foe'], { size: SIZE, grid: emptyGrid(), rng: mulberry32(7) });
    game.players.get('foe')!.x = W - 1 + 0.5;
    game.players.get('foe')!.y = H - 1 + 0.5; // far away: no hunting to distract
    game.powerups.push({ id: 'u1', cx: 6, cy: 0, kind: 'range' });
    const controller = new BotController('bot', 'normal', mulberry32(3));

    const dirs: Direction[] = [];
    let now = 0;
    while (now < 3000 && game.powerups.length > 0) {
      now += TICK_MS;
      const d = controller.update(game, now);
      if (d.dir) dirs.push(d.dir);
      game.setInput('bot', d.dir);
      if (d.bomb) game.placeBomb('bot', now);
      game.update(now, TICK_MS);
    }

    expect(game.powerups.length).toBe(0); // it actually reached and grabbed it
    expect(game.players.get('bot')!.range).toBe(DEFAULT_RANGE + 1); // powerup applied
    // The signature of "weird" wobble is reversing onto the cell you just left.
    for (let i = 1; i < dirs.length; i++) {
      expect(dirs[i]).not.toBe(OPPOSITE[dirs[i - 1]!]);
    }
    // And the route was overwhelmingly straight (all rightward, in fact).
    expect(dirs.every((d) => d === 'right')).toBe(true);
  });
});

describe('bot difficulty differs', () => {
  it('normal hunts a nearby enemy; easy does not pursue', () => {
    const make = (): Game => {
      const g = new Game(['bot', 'foe'], { size: SIZE, grid: emptyGrid(), rng: mulberry32(7) });
      const foe = g.players.get('foe')!;
      foe.x = 5.5;
      foe.y = 0.5; // same row, in engage range for normal
      return g;
    };
    // rng 0.9 keeps easy from taking its occasional random step this tick.
    const normal = new BotController('bot', 'normal', () => 0.5);
    const easy = new BotController('bot', 'easy', () => 0.9);
    expect(normal.update(make(), TICK_MS).dir).toBe('right'); // steps toward the foe
    expect(easy.update(make(), TICK_MS).dir).not.toBe('right'); // wanders instead
  });

  it('normal beats easy across a spread of seeds', () => {
    // A fair duel: real crate maps, realistic sudden-death timing, and spawns
    // alternated each seed so neither side gets the longer-lived corner. A
    // symmetric endgame can legitimately draw, so we only require normal to win
    // the decisive games clearly more often than easy.
    let normalWins = 0;
    let easyWins = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const ids = seed % 2 === 0 ? ['e', 'n'] : ['n', 'e'];
      const game = new Game(ids, {
        size: SIZE,
        grid: generateMap(SIZE, mulberry32(seed)),
        rng: mulberry32(seed),
        suddenDeath: { afterMs: 30_000, intervalMs: 300, warningMs: 1_000 },
      });
      const normal = new BotController('n', 'normal', mulberry32(seed + 100));
      const easy = new BotController('e', 'easy', mulberry32(seed + 200));
      const { winner } = runMatch(game, [normal, easy], 1_400);
      if (winner === 'n') normalWins++;
      else if (winner === 'e') easyWins++;
    }
    expect(normalWins).toBeGreaterThan(easyWins);
  });

  it('bots almost never blow themselves up across many matches', () => {
    // The classic "weird bot" failure is suiciding on its own bomb. Across a
    // spread of self-play matches that should be vanishingly rare.
    let suicides = 0;
    let deaths = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const game = new Game(['a', 'b'], {
        size: SIZE,
        grid: generateMap(SIZE, mulberry32(seed)),
        rng: mulberry32(seed),
        suddenDeath: { afterMs: 30_000, intervalMs: 300, warningMs: 1_000 },
      });
      const a = new BotController('a', 'normal', mulberry32(seed + 100));
      const b = new BotController('b', 'normal', mulberry32(seed + 200));
      const alive = new Map([
        ['a', true],
        ['b', true],
      ]);
      let now = 0;
      for (let i = 0; i < 1_400; i++) {
        now += TICK_MS;
        for (const c of [a, b]) {
          if (!game.players.get(c.playerId)?.alive) continue;
          const d = c.update(game, now);
          game.setInput(c.playerId, d.dir);
          if (d.bomb) game.placeBomb(c.playerId, now);
        }
        // Bombs whose blast lands this tick, with their owner.
        const due = game.bombs
          .filter((bomb) => bomb.explodesAt <= now)
          .map((bomb) => {
            const cells = new Set<number>();
            for (const [dx, dy] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ] as const) {
              cells.add(game.idx(bomb.cx, bomb.cy));
              for (let r = 1; r <= bomb.range; r++) {
                const x = bomb.cx + dx * r;
                const y = bomb.cy + dy * r;
                if (!game.contains(x, y)) break;
                const tile = game.grid[game.idx(x, y)];
                if (tile === TILE_WALL) break;
                cells.add(game.idx(x, y));
                if (tile === TILE_CRATE) break;
              }
            }
            return { owner: bomb.ownerId, cells };
          });
        game.update(now, TICK_MS);
        for (const id of ['a', 'b']) {
          const p = game.players.get(id)!;
          if (alive.get(id) && !p.alive) {
            alive.set(id, false);
            deaths++;
            const k = game.idx(Math.floor(p.x), Math.floor(p.y));
            const ownKilled = due.some((d) => d.owner === id && d.cells.has(k));
            const foeKilled = due.some((d) => d.owner !== id && d.cells.has(k));
            if (ownKilled && !foeKilled) suicides++;
          }
        }
        if (game.alivePlayers().length <= 1) break;
      }
    }
    expect(deaths).toBeGreaterThan(0); // matches actually resolved
    expect(suicides).toBeLessThanOrEqual(2); // self-immolation is rare, not the norm
  });
});

describe('bot self-preservation', () => {
  it('survives a long farming session on a real crate-filled map', () => {
    const game = new Game(['bot', 'foe'], {
      size: SIZE,
      grid: generateMap(SIZE, mulberry32(42)),
      rng: mulberry32(42),
    });
    game.players.get('foe')!.x = W - 1 + 0.5;
    game.players.get('foe')!.y = H - 1 + 0.5; // idle, far away
    const controller = new BotController('bot', 'normal', mulberry32(11));
    runTicks(game, controller, 600); // ~30s of bombing crates near itself
    expect(game.players.get('bot')!.alive).toBe(true); // never blew itself up
  });

  it('grows stronger by farming: gains caps/range/speed over a match', () => {
    const game = new Game(['bot', 'foe'], {
      size: SIZE,
      grid: generateMap(SIZE, mulberry32(9)),
      rng: mulberry32(9),
    });
    game.players.get('foe')!.x = W - 1 + 0.5;
    game.players.get('foe')!.y = H - 1 + 0.5;
    const me = game.players.get('bot')!;
    const start = me.bombCap + me.range + me.speed;
    const controller = new BotController('bot', 'normal', mulberry32(11));
    runTicks(game, controller, 1_500);
    const end = me.bombCap + me.range + me.speed;
    expect(end).toBeGreaterThan(start); // it collected powerups it revealed
  });
});
