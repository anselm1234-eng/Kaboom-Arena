import { describe, expect, it } from 'vitest';
import {
  BOT_FINALE_COUNTDOWN_MS,
  BOT_FINALE_PLAYON_MS,
  PREMATCH_COUNTDOWN_MS,
  READY_TIMEOUT_MS,
  RECONNECT_GRACE_MS,
  ROOM_MAX_PLAYERS,
  ROUND_END_MS,
  mulberry32,
  type ServerMessage,
} from '@blastmates/shared';
import { Room, RoomError, type ClientConn, type RosterPlayer } from '../src/room';

class FakeConn implements ClientConn {
  msgs: ServerMessage[] = [];
  send(msg: ServerMessage): void {
    this.msgs.push(msg);
  }
  last(t: ServerMessage['t']): ServerMessage | undefined {
    return [...this.msgs].reverse().find((m) => m.t === t);
  }
}

function publicRoom(): Room {
  return new Room('test01', false, undefined, { rng: mulberry32(3) });
}

function privateRoom(password?: string): Room {
  return new Room('priv01', true, password, { rng: mulberry32(3) });
}

/**
 * Host start drives through the pre-match countdown; backdating the start
 * request makes the round go live exactly at `now`, so tests keep reasoning
 * about times relative to the moment the match begins.
 */
function hostStart(room: Room, hostId: string, now: number): void {
  room.startByHost(hostId, now - PREMATCH_COUNTDOWN_MS);
  expect(room.state).toBe('countdown');
  room.tick(now);
  expect(room.state).toBe('playing');
}

describe('public room ready-check start', () => {
  it('is hostless: no host is ever assigned and manual start is rejected', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    room.addPlayer('bob', new FakeConn(), 100);
    expect(room.hostId).toBeNull();
    room.handleDisconnect(alice.id, 200);
    expect(room.hostId).toBeNull(); // no migration either
    expect(() => room.startByHost(alice.id, 300)).toThrowError(
      expect.objectContaining({ code: 'not_allowed' }),
    );
  });

  it('validates ready toggles: own players only, never bots, lobby only', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 100);
    const bot = room.addBot(alice.id, 200);
    expect(() => room.setReady(alice.id, bob.id, true, 300)).toThrow(RoomError);
    expect(() => room.setReady(alice.id, bot.id, true, 300)).toThrow(RoomError);
    room.setReady(alice.id, alice.id, true, 400);
    expect(room.roster.get(alice.id)!.ready).toBe(true);
    expect(room.roster.get(bot.id)!.ready).toBe(true); // bots are always ready
  });

  it('starts via the pre-match countdown once every human is ready', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 100);
    room.setReady(alice.id, alice.id, true, 200);
    room.tick(250);
    expect(room.state).toBe('lobby'); // bob is not ready yet
    room.setReady(bob.id, bob.id, true, 300);
    room.tick(350);
    expect(room.state).toBe('countdown');
    expect(room.deadline).toBe(350 + PREMATCH_COUNTDOWN_MS);
    room.tick(350 + PREMATCH_COUNTDOWN_MS);
    expect(room.state).toBe('playing');
    expect(room.game!.players.size).toBe(2);
  });

  it('arms the anti-stall timer on the first ready-up; later readies leave it alone', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 100);
    const carol = room.addPlayer('carol', new FakeConn(), 150);
    expect(room.readyDeadline).toBeNull();
    room.setReady(alice.id, alice.id, true, 200);
    expect(room.readyDeadline).toBe(200 + READY_TIMEOUT_MS);
    room.setReady(bob.id, bob.id, true, 5000);
    expect(room.readyDeadline).toBe(200 + READY_TIMEOUT_MS);
    // Un-readying while others stay ready keeps the timer armed.
    room.setReady(bob.id, bob.id, false, 6000);
    expect(room.readyDeadline).toBe(200 + READY_TIMEOUT_MS);
    room.setReady(carol.id, carol.id, false, 6500); // was never ready: no-op
    room.setReady(alice.id, alice.id, false, 7000);
    expect(room.readyDeadline).toBeNull(); // last ready player un-readied
  });

  it('a single ready human waits out the timer, then fights bots filled to the target', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    room.setReady(alice.id, alice.id, true, 1000);
    room.tick(2000);
    expect(room.state).toBe('lobby'); // all ready, but 1 participant < 2: no instant start
    room.tick(1000 + READY_TIMEOUT_MS);
    expect(room.state).toBe('countdown');
    room.tick(1000 + READY_TIMEOUT_MS + PREMATCH_COUNTDOWN_MS);
    expect(room.state).toBe('playing');
    expect(room.game!.players.size).toBe(4); // 1 human + 3 fill bots
    expect([...room.roster.values()].filter((p) => p.bot && p.autoFill)).toHaveLength(3);
  });

  it('timer expiry launches every connected human, ready or not', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 100);
    const carol = room.addPlayer('carol', new FakeConn(), 200);
    room.setReady(alice.id, alice.id, true, 1000);
    room.setReady(bob.id, bob.id, true, 2000);
    room.tick(30_000);
    expect(room.state).toBe('lobby'); // carol holds up the instant start
    room.tick(1000 + READY_TIMEOUT_MS);
    expect(room.state).toBe('countdown');
    room.tick(1000 + READY_TIMEOUT_MS + PREMATCH_COUNTDOWN_MS);
    expect(room.state).toBe('playing');
    expect(room.game!.players.size).toBe(3); // ready gates the start, not who plays
    expect(room.game!.players.has(carol.id)).toBe(true); // un-ready: spawns anyway
    expect(room.roster.get(carol.id)!.spectator).toBe(false);
  });

  it('all humans ready mid-wait starts instantly, regardless of the timer', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 100);
    const carol = room.addPlayer('carol', new FakeConn(), 200);
    room.setReady(alice.id, alice.id, true, 1000);
    room.setReady(bob.id, bob.id, true, 2000);
    room.tick(10_000);
    expect(room.state).toBe('lobby');
    room.setReady(carol.id, carol.id, true, 20_000);
    room.tick(20_050);
    expect(room.state).toBe('countdown'); // long before the 60s timer
    room.tick(20_050 + PREMATCH_COUNTDOWN_MS);
    expect(room.state).toBe('playing');
    expect(room.game!.players.size).toBe(3);
  });

  it('a new joiner cancels the pre-match countdown but never resets the timer', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 100);
    room.setReady(alice.id, alice.id, true, 200);
    room.setReady(bob.id, bob.id, true, 300);
    room.tick(350);
    expect(room.state).toBe('countdown');
    const carol = room.addPlayer('carol', new FakeConn(), 1000);
    expect(room.state).toBe('lobby'); // countdown canceled
    expect(carol.ready).toBe(false); // joiners arrive un-ready
    expect(room.readyDeadline).toBe(200 + READY_TIMEOUT_MS); // timer untouched
    room.tick(2000);
    expect(room.state).toBe('lobby'); // carol blocks the instant start until the timer
  });

  it('restarts a timer-forced countdown after a joiner cancels it', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    room.setReady(alice.id, alice.id, true, 0);
    room.tick(READY_TIMEOUT_MS);
    expect(room.state).toBe('countdown');
    const bob = room.addPlayer('bob', new FakeConn(), READY_TIMEOUT_MS + 1000);
    expect(room.state).toBe('lobby');
    room.tick(READY_TIMEOUT_MS + 1100); // the timer is long expired: countdown re-arms
    expect(room.state).toBe('countdown');
    expect(room.deadline).toBe(READY_TIMEOUT_MS + 1100 + PREMATCH_COUNTDOWN_MS);
    room.tick(READY_TIMEOUT_MS + 1100 + PREMATCH_COUNTDOWN_MS);
    expect(room.state).toBe('playing');
    expect(room.game!.players.has(bob.id)).toBe(true); // never readied: fights anyway
    expect(room.game!.players.size).toBe(2); // two humans: no bot fill needed
  });

  it('cancels the countdown when its trigger no longer holds', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 100);
    room.setReady(alice.id, alice.id, true, 200);
    room.setReady(bob.id, bob.id, true, 300);
    room.tick(350);
    expect(room.state).toBe('countdown');
    room.setReady(bob.id, bob.id, false, 1000);
    room.tick(1050);
    expect(room.state).toBe('lobby'); // not all ready and the timer is not due
    expect(room.readyDeadline).toBe(200 + READY_TIMEOUT_MS); // alice is still ready
  });

  it('disarms the timer when the last ready player leaves or disconnects', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    room.addPlayer('bob', new FakeConn(), 100);
    room.setReady(alice.id, alice.id, true, 200);
    expect(room.readyDeadline).toBe(200 + READY_TIMEOUT_MS);
    room.handleDisconnect(alice.id, 1000);
    expect(room.readyDeadline).toBeNull();
    expect(room.roster.get(alice.id)!.ready).toBe(false); // rejoins arrive un-ready
    const fresh = new FakeConn();
    room.rejoin(alice.id, fresh, 2000);
    expect(room.roster.get(alice.id)!.ready).toBe(false);
    expect(room.readyDeadline).toBeNull();
  });

  it('returns a player left alone (only fill bots) to the lobby after the round', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    room.setReady(alice.id, alice.id, true, 0);
    room.tick(READY_TIMEOUT_MS);
    room.tick(READY_TIMEOUT_MS + PREMATCH_COUNTDOWN_MS);
    expect(room.state).toBe('playing');
    const bots = [...room.roster.values()].filter((p) => p.bot);
    expect(bots).toHaveLength(3);
    for (const b of bots) room.game!.killPlayer(b.id);
    const t = READY_TIMEOUT_MS + PREMATCH_COUNTDOWN_MS + 1000;
    room.tick(t);
    expect(room.state).toBe('roundEnd');
    room.tick(t + ROUND_END_MS);
    expect(room.state).toBe('lobby'); // solo: no chained round against fresh bots
    expect([...room.roster.values()].some((p) => p.bot)).toBe(false); // fill bots gone
    expect(room.roster.get(alice.id)!.ready).toBe(false);
    expect(room.readyDeadline).toBeNull();
  });

  it('drops fill bots from chained rounds once enough real players are in', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    room.setReady(alice.id, alice.id, true, 0);
    room.tick(READY_TIMEOUT_MS);
    room.tick(READY_TIMEOUT_MS + PREMATCH_COUNTDOWN_MS);
    expect(room.state).toBe('playing');
    expect(room.game!.players.size).toBe(4); // alice + 3 fill bots
    // Bob arrives mid-round; the room has spare slots, so no bot makes way yet.
    const t0 = READY_TIMEOUT_MS + PREMATCH_COUNTDOWN_MS;
    const bob = room.addPlayer('bob', new FakeConn(), t0 + 500);
    expect(bob.spectator).toBe(true);
    expect([...room.roster.values()].filter((p) => p.bot)).toHaveLength(3);
    for (const b of [...room.roster.values()].filter((p) => p.bot)) {
      room.game!.killPlayer(b.id);
    }
    room.game!.killPlayer(bob.id);
    room.tick(t0 + 1000);
    expect(room.state).toBe('roundEnd');
    room.tick(t0 + 1000 + ROUND_END_MS);
    expect(room.state).toBe('playing');
    // Two humans now: every fill bot bows out of the next round.
    expect([...room.roster.values()].some((p) => p.bot)).toBe(false);
    expect([...room.game!.players.keys()].sort()).toEqual([alice.id, bob.id].sort());
  });

  it('keeps manually added bots across chained rounds', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const manual = room.addBot(alice.id, 100);
    room.setReady(alice.id, alice.id, true, 200);
    room.tick(250);
    expect(room.state).toBe('countdown'); // 1 ready human + 1 bot = 2 participants
    room.tick(250 + PREMATCH_COUNTDOWN_MS);
    expect(room.state).toBe('playing');
    expect(room.game!.players.size).toBe(2); // >= 2 participants: no bot fill
    room.game!.killPlayer(manual.id);
    room.tick(10_000);
    expect(room.state).toBe('roundEnd');
    room.tick(10_000 + ROUND_END_MS);
    expect(room.state).toBe('playing'); // alice + the manual bot fight again
    expect(room.roster.has(manual.id)).toBe(true); // manual bots stay
    expect(room.game!.players.has(manual.id)).toBe(true);
  });

  it('reassembles the lobby when the last human disconnects before the next round', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    room.setReady(alice.id, alice.id, true, 0);
    room.tick(READY_TIMEOUT_MS);
    room.tick(READY_TIMEOUT_MS + PREMATCH_COUNTDOWN_MS);
    expect(room.state).toBe('playing');
    const t = READY_TIMEOUT_MS + PREMATCH_COUNTDOWN_MS + 1000;
    room.handleDisconnect(alice.id, t);
    const bots = [...room.roster.values()].filter((p) => p.bot);
    for (const b of bots.slice(1)) room.game!.killPlayer(b.id);
    room.tick(t + 50);
    expect(room.state).toBe('roundEnd'); // one bot left standing wins
    room.tick(t + 50 + ROUND_END_MS);
    expect(room.state).toBe('lobby'); // nobody to play for: wait, don't chain
    expect([...room.roster.values()].some((p) => p.bot)).toBe(false); // fill bots gone
    expect(room.readyDeadline).toBeNull();
  });

  it('locals ready up independently and the start waits for every one of them', () => {
    const room = publicRoom();
    const conn = new FakeConn();
    const alice = room.addPlayer('alice', conn, 0);
    const local = room.addLocalPlayer(alice.id, 10);
    room.setReady(alice.id, alice.id, true, 100);
    room.tick(150);
    expect(room.state).toBe('lobby'); // the local pad is not ready yet
    room.setReady(alice.id, local.id, true, 200); // owner toggles their own local
    room.tick(250);
    expect(room.state).toBe('countdown'); // 2 ready participants
  });
});

describe('public room bot controls', () => {
  it('lets any player add and remove bots', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 100);
    const bot = room.addBot(bob.id, 200); // non-first-joiner: fine, hostless
    room.addBot(bob.id, 300); // back-to-back adds are fine
    room.addBot(alice.id, 400);
    room.removeBot(bob.id, bot.id, 500);
    expect(room.roster.has(bot.id)).toBe(false);
  });

  it('displaces a bot when a human joins a full lobby', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 100);
    const bots = [];
    for (let t = 200; room.roster.size < ROOM_MAX_PLAYERS; t += 100) {
      bots.push(room.addBot(bots.length % 2 === 0 ? alice.id : bob.id, t));
    }
    expect(room.hasSlot()).toBe(false);
    const carol = room.addPlayer('carol', new FakeConn(), 10_000);
    expect(room.roster.has(carol.id)).toBe(true);
    expect(room.roster.has(bots[0]!.id)).toBe(true);
    expect(room.roster.has(bots.at(-1)!.id)).toBe(false); // newest bot displaced
    expect(room.roster.size).toBe(ROOM_MAX_PLAYERS);
  });

  it('never displaces a bot mid-match', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 100);
    let n = 0;
    for (let t = 200; room.roster.size < ROOM_MAX_PLAYERS; t += 1100) {
      room.addBot(n++ % 2 === 0 ? alice.id : bob.id, t); // alternate: no shared cooldown
    }
    room.setReady(alice.id, alice.id, true, 10_000);
    room.setReady(bob.id, bob.id, true, 10_100);
    room.tick(10_150);
    room.tick(10_150 + PREMATCH_COUNTDOWN_MS);
    expect(room.state).toBe('playing');
    expect(() => room.addPlayer('late', new FakeConn(), 20_000)).toThrowError(
      expect.objectContaining({ code: 'room_full' }),
    );
  });
});

describe('win detection and rounds', () => {
  function startedRoom(): { room: Room; ids: string[]; conns: FakeConn[] } {
    const room = privateRoom();
    const conns = [new FakeConn(), new FakeConn(), new FakeConn()];
    const ids = ['alice', 'bob', 'carol'].map((n, i) => room.addPlayer(n, conns[i]!, 0).id);
    hostStart(room, ids[0]!, 10);
    expect(room.state).toBe('playing');
    return { room, ids, conns };
  }

  it('declares the last player alive the winner and tallies the win', () => {
    const { room, ids } = startedRoom();
    room.game!.killPlayer(ids[0]!);
    room.tick(11_000);
    expect(room.state).toBe('playing'); // two still alive

    room.game!.killPlayer(ids[1]!);
    room.tick(11_050);
    expect(room.state).toBe('roundEnd');
    expect(room.winnerId).toBe(ids[2]);
    expect(room.roster.get(ids[2]!)!.wins).toBe(1);
  });

  it('calls a draw when nobody survives', () => {
    const { room, ids } = startedRoom();
    for (const id of ids) room.game!.killPlayer(id);
    room.tick(11_050);
    expect(room.state).toBe('roundEnd');
    expect(room.winnerId).toBeNull();
  });

  it('starts a fresh round with a fresh map after the round-end pause', () => {
    const { room, ids } = startedRoom();
    const firstGame = room.game;
    room.game!.killPlayer(ids[0]!);
    room.game!.killPlayer(ids[1]!);
    room.tick(11_050);
    room.tick(11_050 + ROUND_END_MS);
    expect(room.state).toBe('playing');
    expect(room.game).not.toBe(firstGame);
    expect(room.game!.alivePlayers()).toHaveLength(3);
  });

  it('treats a disconnect during play as a death', () => {
    const { room, ids } = startedRoom();
    room.handleDisconnect(ids[0]!, 11_000);
    room.handleDisconnect(ids[1]!, 11_000);
    room.tick(11_050);
    expect(room.state).toBe('roundEnd');
    expect(room.winnerId).toBe(ids[2]);
  });

  it('makes mid-round joiners spectators who play the next round', () => {
    const room = privateRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 0);
    hostStart(room, alice.id, 10);
    expect(room.state).toBe('playing');

    const carol = room.addPlayer('carol', new FakeConn(), 20_000);
    expect(carol.spectator).toBe(true);
    expect(room.game!.players.has(carol.id)).toBe(false);

    // Round ends; after the 5s break carol is dealt in.
    room.game!.killPlayer(bob.id);
    room.tick(20_050);
    expect(room.state).toBe('roundEnd');
    room.tick(20_050 + ROUND_END_MS);
    expect(room.state).toBe('playing');
    expect(room.game!.players.has(carol.id)).toBe(true);
    expect(room.roster.get(carol.id)!.spectator).toBe(false);
  });
});

describe('reconnect grace', () => {
  it('lets a player rejoin as spectator within the grace window', () => {
    const room = privateRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    room.addPlayer('bob', new FakeConn(), 0);
    hostStart(room, alice.id, 10);
    room.handleDisconnect(alice.id, 12_000);

    const fresh = new FakeConn();
    const rejoined = room.rejoin(alice.id, fresh, 15_000);
    expect(rejoined).not.toBeNull();
    expect(rejoined!.spectator).toBe(true);
    expect(rejoined!.connected).toBe(true);
  });

  it('drops the player entirely after the grace window expires', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    room.addPlayer('bob', new FakeConn(), 0);
    room.handleDisconnect(alice.id, 1000);
    room.tick(1000 + RECONNECT_GRACE_MS);
    expect(room.roster.has(alice.id)).toBe(false);
  });
});

describe('private rooms', () => {
  it('validates passwords', () => {
    const room = privateRoom('sekret');
    expect(room.hasPassword()).toBe(true);
    expect(room.checkPassword('sekret')).toBe(true);
    expect(room.checkPassword('nope')).toBe(false);
    expect(privateRoom().checkPassword(undefined)).toBe(true);
  });

  it('never auto-starts; only the host can start', () => {
    const room = privateRoom();
    const host = room.addPlayer('alice', new FakeConn(), 0);
    const guest = room.addPlayer('bob', new FakeConn(), 100);
    room.tick(60_000);
    expect(room.state).toBe('lobby'); // no auto-start for private rooms

    expect(room.hostId).toBe(host.id);
    expect(() => room.startByHost(guest.id, 60_000)).toThrow(RoomError);
    hostStart(room, host.id, 60_000);
    expect(room.state).toBe('playing');
  });

  it('requires two players to start', () => {
    const room = privateRoom();
    const host = room.addPlayer('alice', new FakeConn(), 0);
    expect(() => room.startByHost(host.id, 100)).toThrow(RoomError);
  });

  it('host start runs the pre-match countdown; it cancels if the room thins out', () => {
    const room = privateRoom();
    const host = room.addPlayer('alice', new FakeConn(), 0);
    const guest = room.addPlayer('bob', new FakeConn(), 100);
    room.startByHost(host.id, 200);
    expect(room.state).toBe('countdown');
    expect(() => room.startByHost(host.id, 300)).toThrow(RoomError); // no double start

    // Guest leaves mid-countdown: back to the lobby instead of a 1-player match.
    room.handleDisconnect(guest.id, 500);
    room.tick(600);
    expect(room.state).toBe('lobby');
    expect(room.game).toBeNull();

    // With everyone back, the countdown runs to completion and the match starts.
    room.rejoin(guest.id, new FakeConn(), 700);
    room.startByHost(host.id, 800);
    room.tick(800 + PREMATCH_COUNTDOWN_MS - 1);
    expect(room.state).toBe('countdown'); // not a millisecond early
    room.tick(800 + PREMATCH_COUNTDOWN_MS);
    expect(room.state).toBe('playing');
  });

  it('migrates the host when the host disconnects', () => {
    const room = privateRoom();
    const host = room.addPlayer('alice', new FakeConn(), 0);
    const guest = room.addPlayer('bob', new FakeConn(), 100);
    expect(room.hostId).toBe(host.id);
    room.handleDisconnect(host.id, 1000);
    expect(room.hostId).toBe(guest.id);
  });

  it('treats ready states as advisory: no timer, no countdown, no auto start', () => {
    const room = privateRoom();
    const host = room.addPlayer('alice', new FakeConn(), 0);
    const guest = room.addPlayer('bob', new FakeConn(), 100);
    room.setReady(guest.id, guest.id, true, 200);
    room.setReady(host.id, host.id, true, 300);
    expect(room.readyDeadline).toBeNull(); // anti-stall timer never arms
    room.tick(300 + READY_TIMEOUT_MS + 1000);
    expect(room.state).toBe('lobby'); // everyone ready means nothing without the host
    hostStart(room, host.id, 70_000);
    expect(room.state).toBe('playing');
  });

  it('keeps cycling rounds automatically after the initial host start', () => {
    const room = privateRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 0);
    hostStart(room, alice.id, 10);
    room.game!.killPlayer(bob.id);
    room.tick(1000);
    expect(room.state).toBe('roundEnd');
    room.tick(1000 + ROUND_END_MS);
    expect(room.state).toBe('playing'); // no host action needed between rounds
  });
});

describe('host kick', () => {
  it('lets the host kick a guest, who is told why and removed immediately', () => {
    const room = privateRoom();
    const host = room.addPlayer('alice', new FakeConn(), 0);
    const bobConn = new FakeConn();
    const bob = room.addPlayer('bob', bobConn, 100);
    room.kickPlayer(host.id, bob.id, 200);
    expect(bobConn.last('kicked')).toEqual({ t: 'kicked', reason: 'host', playerId: bob.id });
    expect(room.roster.has(bob.id)).toBe(false); // no reconnect grace
  });

  it('kicks the whole connection group, whichever member is targeted', () => {
    const room = privateRoom();
    const host = room.addPlayer('alice', new FakeConn(), 0);
    const bobConn = new FakeConn();
    const bob = room.addPlayer('bob', bobConn, 100);
    const l2 = room.addLocalPlayer(bob.id, 110);
    const l3 = room.addLocalPlayer(bob.id, 120);
    room.kickPlayer(host.id, l2.id, 200); // targeting a local kicks the owner too
    expect(room.roster.has(bob.id)).toBe(false);
    expect(room.roster.has(l2.id)).toBe(false);
    expect(room.roster.has(l3.id)).toBe(false);
    // The shared connection hears about it exactly once, as the primary.
    expect(bobConn.msgs.filter((m) => m.t === 'kicked')).toEqual([
      { t: 'kicked', reason: 'host', playerId: bob.id },
    ]);
  });

  it('rejects kicks from non-hosts, in public rooms, and outside the lobby', () => {
    const pub = publicRoom();
    const p1 = pub.addPlayer('alice', new FakeConn(), 0);
    const p2 = pub.addPlayer('bob', new FakeConn(), 100);
    expect(() => pub.kickPlayer(p1.id, p2.id, 200)).toThrowError(
      expect.objectContaining({ code: 'not_allowed' }),
    );

    const room = privateRoom();
    const host = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 100);
    expect(() => room.kickPlayer(bob.id, host.id, 200)).toThrowError(
      expect.objectContaining({ code: 'not_host' }),
    );
    hostStart(room, host.id, 300);
    expect(() => room.kickPlayer(host.id, bob.id, 400)).toThrowError(
      expect.objectContaining({ code: 'cannot_start' }),
    );
  });

  it('never kicks the host connection itself, bots, or unknown players', () => {
    const room = privateRoom();
    const host = room.addPlayer('alice', new FakeConn(), 0);
    const local = room.addLocalPlayer(host.id, 10);
    const bot = room.addBot(host.id, 20);
    expect(() => room.kickPlayer(host.id, host.id, 100)).toThrow(RoomError);
    expect(() => room.kickPlayer(host.id, local.id, 100)).toThrow(RoomError);
    expect(() => room.kickPlayer(host.id, bot.id, 100)).toThrow(RoomError); // bots use removeBot
    expect(() => room.kickPlayer(host.id, 'nope', 100)).toThrow(RoomError);
  });

  it('lets a migrated host kick, and host migration survives a kick', () => {
    const room = privateRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 100);
    const carol = room.addPlayer('carol', new FakeConn(), 200);
    expect(() => room.kickPlayer(bob.id, carol.id, 300)).toThrow(RoomError);
    room.removeConnection(alice.id, 400); // host leaves; bob inherits
    expect(room.hostId).toBe(bob.id);
    room.kickPlayer(bob.id, carol.id, 500);
    expect(room.roster.has(carol.id)).toBe(false);
  });
});

describe('sudden death integration', () => {
  function sdRoom(): Room {
    return new Room('sd01', true, undefined, {
      rng: mulberry32(3),
      suddenDeath: { afterMs: 1000, intervalMs: 100, warningMs: 200 },
    });
  }

  it('streams suddenDeathAt and crush warnings in snapshots', () => {
    const room = sdRoom();
    const conn = new FakeConn();
    const alice = room.addPlayer('alice', conn, 0);
    room.addPlayer('bob', new FakeConn(), 50);
    hostStart(room, alice.id, 100);
    room.tick(150); // first game update: schedule pinned to t=150
    let snap = conn.last('snapshot');
    expect(snap?.t === 'snapshot' && snap.suddenDeathAt).toBe(1150);
    expect(snap?.t === 'snapshot' && snap.crush).toEqual([]);

    room.tick(1200); // sudden death started; first warning is showing
    snap = conn.last('snapshot');
    expect(snap?.t === 'snapshot' && snap.crush).toEqual([
      { x: 0, y: 0, landsAt: 1350 },
    ]);
  });

  it('ends an idle stalemate match: the spiral crushes both players', () => {
    const room = sdRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    room.addPlayer('bob', new FakeConn(), 50);
    hostStart(room, alice.id, 100);

    let now = 100;
    while (room.state === 'playing' && now < 60_000) {
      now += 50;
      room.tick(now);
    }
    expect(room.state).toBe('roundEnd');
    // Alice spawns on the spiral's first tile; idle Bob survives her and wins.
    expect(room.winnerId).not.toBeNull();
    expect(room.winnerId).not.toBe(alice.id);
  });
});

describe('AFK kick', () => {
  const AFK = { warningMs: 1000, kickMs: 2000 };

  function afkRoom(): { room: Room; ids: string[]; conns: FakeConn[] } {
    const room = new Room('afk01', true, undefined, { rng: mulberry32(3), afk: AFK });
    const conns = [new FakeConn(), new FakeConn(), new FakeConn()];
    const ids = ['alice', 'bob', 'carol'].map((n, i) => room.addPlayer(n, conns[i]!, 0).id);
    hostStart(room, ids[0]!, 10); // AFK clocks start at t=10
    expect(room.state).toBe('playing');
    return { room, ids, conns };
  }

  /** Tick along, keeping everyone except `idleIds` active via trivial inputs. */
  function runWithActivity(
    room: Room,
    ids: string[],
    idleIds: string[],
    fromMs: number,
    toMs: number,
  ): void {
    for (let t = fromMs + 50; t <= toMs; t += 50) {
      for (const id of ids) {
        if (!idleIds.includes(id) && room.roster.has(id)) room.handleInput(id, null, t);
      }
      room.tick(t);
    }
  }

  function lastAfk(conn: FakeConn): number | null | undefined {
    const msg = conn.last('afk');
    return msg?.t === 'afk' ? msg.kickAt : undefined;
  }

  it('warns only the idle alive player at the warning threshold', () => {
    const { room, ids, conns } = afkRoom();
    runWithActivity(room, ids, [ids[0]!], 10, 1500);
    expect(lastAfk(conns[0]!)).toBe(2010); // kick due at lastInput(10) + kickMs
    expect(conns[1]!.last('afk')).toBeUndefined();
    expect(room.roster.has(ids[0]!)).toBe(true); // warned, not yet removed
  });

  it('kicks at the kick threshold through the normal leave path', () => {
    const { room, ids, conns } = afkRoom();
    runWithActivity(room, ids, [ids[0]!], 10, 2100);
    expect(conns[0]!.last('kicked')).toEqual({ t: 'kicked', reason: 'afk', playerId: ids[0] });
    expect(room.roster.has(ids[0]!)).toBe(false);
    expect(room.state).toBe('playing'); // the others fight on
    expect(room.game!.alivePlayers().map((p) => p.id)).not.toContain(ids[0]);
  });

  it('counts a kick as an elimination with no kill credit: last one standing wins', () => {
    const { room, ids } = afkRoom();
    runWithActivity(room, ids, [ids[0]!, ids[1]!], 10, 2100);
    expect(room.state).toBe('roundEnd');
    expect(room.winnerId).toBe(ids[2]);
    expect(room.roster.get(ids[2]!)!.wins).toBe(1);
  });

  it('clears the warning and resets the timer on any input, even a key release', () => {
    const { room, ids, conns } = afkRoom();
    runWithActivity(room, ids, [ids[0]!], 10, 1200);
    expect(lastAfk(conns[0]!)).toBe(2010); // warning showing
    room.handleInput(ids[0]!, null, 1250); // trivial input still counts
    expect(lastAfk(conns[0]!)).toBeNull(); // warning cleared instantly
    runWithActivity(room, ids, [ids[0]!], 1250, 3200);
    expect(room.roster.has(ids[0]!)).toBe(true); // new deadline is 3250
    runWithActivity(room, ids, [ids[0]!], 3200, 3300);
    expect(room.roster.has(ids[0]!)).toBe(false);
  });

  it('clears the warning when the player dies and never kicks dead spectators', () => {
    const { room, ids, conns } = afkRoom();
    runWithActivity(room, ids, [ids[0]!], 10, 1200);
    expect(lastAfk(conns[0]!)).toBe(2010);
    room.game!.killPlayer(ids[0]!);
    runWithActivity(room, ids, [ids[0]!], 1200, 1300);
    expect(lastAfk(conns[0]!)).toBeNull(); // died mid-warning: cleared
    runWithActivity(room, ids, [ids[0]!], 1300, 6000); // idles way past kickMs
    expect(room.roster.has(ids[0]!)).toBe(true);
    expect(conns[0]!.last('kicked')).toBeUndefined();
    expect(room.state).toBe('playing');
  });

  it('starts the AFK clock at round start, never in the lobby', () => {
    const room = new Room('afk02', true, undefined, { rng: mulberry32(3), afk: AFK });
    const conn = new FakeConn();
    const host = room.addPlayer('alice', conn, 0);
    room.addPlayer('bob', new FakeConn(), 0);
    for (let t = 50; t <= 10_000; t += 50) room.tick(t); // idle in lobby
    expect(conn.msgs.filter((m) => m.t === 'afk' || m.t === 'kicked')).toEqual([]);
    expect(room.roster.size).toBe(2);

    hostStart(room, host.id, 10_000);
    room.tick(10_500);
    expect(conn.last('afk')).toBeUndefined(); // only 500ms idle since live
    for (let t = 10_550; t <= 11_100; t += 50) room.tick(t);
    expect(lastAfk(conn)).toBe(12_000); // clock started at round start
  });

  it('leaves disconnected players to the reconnect grace and resets on rejoin', () => {
    const { room, ids, conns } = afkRoom();
    room.handleDisconnect(ids[0]!, 500);
    runWithActivity(room, ids, [ids[0]!], 500, 3000); // far past kickMs, within grace
    expect(room.roster.has(ids[0]!)).toBe(true);
    expect(conns[0]!.last('kicked')).toBeUndefined();

    const fresh = new FakeConn();
    room.rejoin(ids[0]!, fresh, 3000); // back as a spectator
    runWithActivity(room, ids, [ids[0]!], 3000, 8000);
    expect(room.roster.has(ids[0]!)).toBe(true); // spectators are never AFK-checked
    expect(fresh.last('kicked')).toBeUndefined();
  });

  it('never kicks bots', () => {
    const room = new Room('afk03', true, undefined, { rng: mulberry32(3), afk: AFK });
    const conn = new FakeConn();
    const host = room.addPlayer('alice', conn, 0);
    room.addPlayer('bob', new FakeConn(), 0);
    const bot = room.addBot(host.id, 0);
    hostStart(room, host.id, 10);
    const humans = [host.id, ...room.connectedPlayers().filter((p) => !p.bot).map((p) => p.id)];
    runWithActivity(room, humans, [], 10, 5000);
    expect(room.roster.has(bot.id)).toBe(true);
  });
});

describe('local players (shared connection)', () => {
  it('adds local players with default names, LOCAL ownership and normal slots', () => {
    const room = publicRoom();
    const conn = new FakeConn();
    const alice = room.addPlayer('alice', conn, 0);
    const p2 = room.addLocalPlayer(alice.id, 100);
    const p3 = room.addLocalPlayer(alice.id, 200);
    expect(p2.nickname).toBe('Player 2');
    expect(p3.nickname).toBe('Player 3');
    expect(p2.ownerId).toBe(alice.id);
    expect(p2.conn).toBe(conn);
    expect(room.roster.size).toBe(3);

    const msg = room.roomMessage(300);
    const players = msg.t === 'room' ? msg.players : [];
    expect(players.find((p) => p.id === p2.id)?.ownerId).toBe(alice.id);
    expect(players.find((p) => p.id === alice.id)?.ownerId).toBeUndefined();
  });

  it('caps locals at 4 per device and respects the room size', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    room.addLocalPlayer(alice.id, 1);
    room.addLocalPlayer(alice.id, 2);
    room.addLocalPlayer(alice.id, 3);
    expect(() => room.addLocalPlayer(alice.id, 4)).toThrow(RoomError); // 4 already

    const room2 = privateRoom();
    const bob = room2.addPlayer('bob', new FakeConn(), 0);
    room2.addPlayer('carol', new FakeConn(), 1);
    for (let i = 2; room2.roster.size < ROOM_MAX_PLAYERS; i++) room2.addBot(bob.id, i);
    expect(() => room2.addLocalPlayer(bob.id, 100)).toThrow(RoomError); // room full
  });

  it('displaces a bot in a full public lobby instead of rejecting the local', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 1);
    const bots = [];
    for (let t = 200; room.roster.size < ROOM_MAX_PLAYERS; t += 1100) {
      bots.push(room.addBot(bots.length % 2 === 0 ? alice.id : bob.id, t));
    }
    expect(room.hasSlot()).toBe(false);
    const local = room.addLocalPlayer(alice.id, 10_000);
    expect(room.roster.has(local.id)).toBe(true);
    expect(room.roster.has(bots.at(-1)!.id)).toBe(false);
  });

  it('rejects local players mid-match, from bots, and from other locals', () => {
    const room = privateRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const local = room.addLocalPlayer(alice.id, 10);
    expect(() => room.addLocalPlayer(local.id, 20)).toThrow(RoomError); // locals can't own
    const bot = room.addBot(alice.id, 30);
    expect(() => room.addLocalPlayer(bot.id, 40)).toThrow(RoomError);

    hostStart(room, alice.id, 50);
    expect(room.state).toBe('playing');
    expect(() => room.addLocalPlayer(alice.id, 60)).toThrow(RoomError); // lobby only
  });

  it('validates input ownership across connections', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 1);
    const local = room.addLocalPlayer(alice.id, 2);
    expect(room.ownsPlayer(alice.id, alice.id)).toBe(true);
    expect(room.ownsPlayer(alice.id, local.id)).toBe(true);
    expect(room.ownsPlayer(bob.id, local.id)).toBe(false);
    expect(room.ownsPlayer(bob.id, alice.id)).toBe(false);
  });

  it('routes a local pad through the normal input pipeline into the game', () => {
    const room = privateRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const local = room.addLocalPlayer(alice.id, 10);
    hostStart(room, alice.id, 20);
    expect(room.game!.players.has(local.id)).toBe(true); // locals fight like anyone

    room.handleInput(local.id, 'down', 100);
    expect(room.game!.players.get(local.id)!.dir).toBe('down');
    expect(room.game!.players.get(alice.id)!.dir).toBeNull(); // owner unaffected
  });

  it('removes and renames only your own locals, lobby only', () => {
    const room = privateRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 1);
    const local = room.addLocalPlayer(alice.id, 2);

    expect(() => room.removeLocalPlayer(bob.id, local.id, 10)).toThrow(RoomError);
    expect(() => room.renameLocalPlayer(bob.id, local.id, 'hax', 10)).toThrow(RoomError);
    expect(() => room.removeLocalPlayer(alice.id, bob.id, 10)).toThrow(RoomError);

    room.renameLocalPlayer(alice.id, local.id, 'Lefty', 20);
    expect(room.roster.get(local.id)!.nickname).toBe('Lefty');

    room.removeLocalPlayer(alice.id, local.id, 30);
    expect(room.roster.has(local.id)).toBe(false); // slot freed

    const local2 = room.addLocalPlayer(alice.id, 40);
    hostStart(room, alice.id, 50);
    expect(() => room.removeLocalPlayer(alice.id, local2.id, 60)).toThrow(RoomError);
  });

  it('disconnect takes all locals offline and rejoin brings them all back', () => {
    const room = privateRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const local = room.addLocalPlayer(alice.id, 10);
    room.addPlayer('bob', new FakeConn(), 20);
    hostStart(room, alice.id, 30);

    room.handleDisconnect(alice.id, 1000);
    expect(room.roster.get(local.id)!.connected).toBe(false);
    expect(room.game!.players.get(local.id)!.alive).toBe(false);

    const fresh = new FakeConn();
    room.rejoin(alice.id, fresh, 2000);
    expect(room.roster.get(local.id)!.connected).toBe(true);
    expect(room.roster.get(local.id)!.conn).toBe(fresh);
    expect(room.roster.get(local.id)!.spectator).toBe(true); // back next round
  });

  it('expires all locals together after the reconnect grace', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const local = room.addLocalPlayer(alice.id, 10);
    room.addPlayer('bob', new FakeConn(), 20);
    room.handleDisconnect(alice.id, 1000);
    room.tick(1000 + RECONNECT_GRACE_MS);
    expect(room.roster.has(alice.id)).toBe(false);
    expect(room.roster.has(local.id)).toBe(false);
  });

  it('leave removes the whole connection group via removeConnection', () => {
    const room = publicRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const l2 = room.addLocalPlayer(alice.id, 10);
    const l3 = room.addLocalPlayer(alice.id, 20);
    room.addPlayer('bob', new FakeConn(), 30);
    room.removeConnection(alice.id, 40);
    expect(room.roster.has(alice.id)).toBe(false);
    expect(room.roster.has(l2.id)).toBe(false);
    expect(room.roster.has(l3.id)).toBe(false);
    expect(room.roster.size).toBe(1); // bob keeps the room
  });

  it('broadcasts once per connection despite shared sockets', () => {
    const room = publicRoom();
    const conn = new FakeConn();
    const alice = room.addPlayer('alice', conn, 0);
    room.addLocalPlayer(alice.id, 10);
    room.addLocalPlayer(alice.id, 20);
    conn.msgs.length = 0;
    room.setReady(alice.id, alice.id, true, 30); // triggers one room broadcast
    expect(conn.msgs.filter((m) => m.t === 'room')).toHaveLength(1);
  });

  it('lets one human + one local start a match and AFK-kicks locals individually', () => {
    const AFK = { warningMs: 1000, kickMs: 2000 };
    const room = new Room('loc01', true, undefined, { rng: mulberry32(3), afk: AFK });
    const conn = new FakeConn();
    const alice = room.addPlayer('alice', conn, 0);
    const local = room.addLocalPlayer(alice.id, 5);
    hostStart(room, alice.id, 10); // 2 eligible players: owner + local
    expect(room.state).toBe('playing');

    // Owner stays active; the local pad goes idle.
    for (let t = 60; t <= 2100; t += 50) {
      room.handleInput(alice.id, null, t);
      room.tick(t);
    }
    const kicked = conn.msgs.filter((m) => m.t === 'kicked');
    expect(kicked).toEqual([{ t: 'kicked', reason: 'afk', playerId: local.id }]);
    expect(room.roster.has(alice.id)).toBe(true); // owner plays on
    expect(room.roster.has(local.id)).toBe(false);
  });

  it('tags AFK warnings with the player they are about', () => {
    const AFK = { warningMs: 1000, kickMs: 2000 };
    const room = new Room('loc02', true, undefined, { rng: mulberry32(3), afk: AFK });
    const conn = new FakeConn();
    const alice = room.addPlayer('alice', conn, 0);
    const local = room.addLocalPlayer(alice.id, 5);
    hostStart(room, alice.id, 10);
    for (let t = 60; t <= 1200; t += 50) {
      room.handleInput(alice.id, null, t);
      room.tick(t);
    }
    const warning = conn.last('afk');
    expect(warning?.t === 'afk' && warning.playerId).toBe(local.id);
  });
});

describe('sudden death edge cases', () => {
  it('keeps the spiral on schedule when a player leaves mid-shrink', () => {
    const room = new Room('sd02', true, undefined, {
      rng: mulberry32(3),
      suddenDeath: { afterMs: 1000, intervalMs: 100, warningMs: 200 },
    });
    const conn = new FakeConn();
    const alice = room.addPlayer('alice', conn, 0);
    const bob = room.addPlayer('bob', new FakeConn(), 50);
    room.addPlayer('carol', new FakeConn(), 60);
    hostStart(room, alice.id, 100);

    // Schedule pins to the first tick (150): landings at 1350, 1450, 1550...
    let now = 100;
    while (now < 1500) {
      now += 50;
      room.tick(now);
    }
    expect(room.state).toBe('playing'); // alice crushed at (0,0); two remain
    room.removePlayer(bob.id, now); // bob leaves mid-spiral

    while (now < 1600) {
      now += 50;
      room.tick(now);
    }
    // (2,0) still landed at its original time: the sequence did not desync.
    const snap = conn.last('snapshot');
    expect(snap?.t === 'snapshot' && snap.grid[2]).toBe('X');
    expect(room.state).toBe('roundEnd'); // bob's leave left carol the winner
  });
});

describe('room size', () => {
  function sizedPrivateRoom(size: 4 | 6 | 8): Room {
    return new Room('size01', true, undefined, { rng: mulberry32(3), size });
  }

  it('defaults to 8 players and reports the configured cap in room messages', () => {
    const small = new Room('size02', true, undefined, { rng: mulberry32(3), size: 4 });
    expect(publicRoom().maxPlayers).toBe(8);
    expect(small.maxPlayers).toBe(4);
    const conn = new FakeConn();
    small.addPlayer('alice', conn, 0);
    const msg = conn.last('room');
    expect(msg).toMatchObject({ t: 'room', maxPlayers: 4 });
  });

  it('generates the map dimensions configured for the room size', () => {
    const dims: Array<[4 | 6 | 8, number, number]> = [
      [4, 13, 11],
      [6, 15, 13],
      [8, 17, 15],
    ];
    for (const [size, w, h] of dims) {
      const room = sizedPrivateRoom(size);
      const host = room.addPlayer('host', new FakeConn(), 0);
      room.addPlayer('guest', new FakeConn(), 100);
      hostStart(room, host.id, 200);
      expect(room.game!.width).toBe(w);
      expect(room.game!.height).toBe(h);
      expect(room.game!.grid).toHaveLength(w * h);
    }
  });

  it('caps joins, bots and bot auto-fill at the configured size', () => {
    const room = sizedPrivateRoom(4);
    const host = room.addPlayer('host', new FakeConn(), 0);
    room.addPlayer('p2', new FakeConn(), 100);
    room.addBot(host.id, 200);
    room.addBot(host.id, 300);
    expect(room.roster.size).toBe(4);
    expect(() => room.addBot(host.id, 400)).toThrowError(
      expect.objectContaining({ code: 'room_full' }),
    );
    expect(() => room.addPlayer('p5', new FakeConn(), 500)).toThrowError(
      expect.objectContaining({ code: 'room_full' }),
    );
  });

  it('public auto-fill respects a size smaller than the fill target', () => {
    const room = new Room('size03', false, undefined, {
      rng: mulberry32(3),
      size: 4,
      publicStart: { botFillTarget: 6, readyTimeoutMs: 1000 },
    });
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    room.setReady(alice.id, alice.id, true, 100);
    room.tick(1200); // anti-stall timer fires for the lone ready player
    room.tick(1200 + PREMATCH_COUNTDOWN_MS);
    expect(room.state).toBe('playing');
    expect(room.roster.size).toBe(4); // fill target clamped to the room size
  });

  it('host can resize a private room in the lobby; size persists to the game', () => {
    const room = sizedPrivateRoom(8);
    const host = room.addPlayer('host', new FakeConn(), 0);
    room.addPlayer('guest', new FakeConn(), 100);
    room.setSize(host.id, 4, 200);
    expect(room.maxPlayers).toBe(4);
    hostStart(room, host.id, 300);
    expect(room.game!.width).toBe(13);
  });

  it('rejects resizing below the current participant count (humans + bots)', () => {
    const room = sizedPrivateRoom(8);
    const host = room.addPlayer('host', new FakeConn(), 0);
    room.addPlayer('p2', new FakeConn(), 100);
    room.addPlayer('p3', new FakeConn(), 200);
    room.addPlayer('p4', new FakeConn(), 300);
    room.addBot(host.id, 400); // 5 participants
    expect(() => room.setSize(host.id, 4, 500)).toThrowError(
      expect.objectContaining({ code: 'not_allowed' }),
    );
    room.setSize(host.id, 6, 600); // 5 <= 6: allowed
    expect(room.maxPlayers).toBe(6);
  });

  it('only the host can resize, and only in the lobby', () => {
    const room = sizedPrivateRoom(8);
    const host = room.addPlayer('host', new FakeConn(), 0);
    const guest = room.addPlayer('guest', new FakeConn(), 100);
    expect(() => room.setSize(guest.id, 4, 200)).toThrowError(
      expect.objectContaining({ code: 'not_host' }),
    );
    hostStart(room, host.id, 300);
    expect(() => room.setSize(host.id, 4, 400)).toThrowError(
      expect.objectContaining({ code: 'cannot_start' }),
    );
  });

  it('public room size is immutable, even for its players', () => {
    const room = new Room('size04', false, undefined, { rng: mulberry32(3), size: 6 });
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    expect(() => room.setSize(alice.id, 4, 100)).toThrowError(
      expect.objectContaining({ code: 'not_allowed' }),
    );
    expect(room.maxPlayers).toBe(6);
  });
});

describe('bot-only endgame resolution', () => {
  type Snap = Extract<ServerMessage, { t: 'snapshot' }>;
  const FINALE_MS = BOT_FINALE_PLAYON_MS + BOT_FINALE_COUNTDOWN_MS;

  /** One human plus a crowd of bots, round live with the clock pinned to 1000. */
  function botRoom(conn = new FakeConn()): { room: Room; alice: RosterPlayer; conn: FakeConn } {
    const room = new Room('ff01', true, undefined, { rng: mulberry32(3), size: 8 });
    const alice = room.addPlayer('alice', conn, 0);
    for (let i = 0; i < 6; i++) room.addBot(alice.id, 20 + i);
    hostStart(room, alice.id, 1000);
    return { room, alice, conn };
  }

  it('keeps playing in real time while a human is still alive', () => {
    const { room, conn } = botRoom();
    room.tick(1050);
    expect(room.state).toBe('playing');
    expect(room.game!.alivePlayers().length).toBe(7); // nobody auto-resolved
    const snap = [...conn.msgs].reverse().find((m): m is Snap => m.t === 'snapshot');
    expect(snap!.botFinaleAt).toBeUndefined(); // no finale armed
  });

  it('plays on through a finale window, then crowns one bot and ends the round', () => {
    const { room, alice, conn } = botRoom();
    // Last human dies with six bots still fighting: the finale arms but the
    // round keeps playing - no instant resolution.
    room.game!.killPlayer(alice.id);
    room.tick(1050);
    expect(room.state).toBe('playing');
    const armed = [...conn.msgs].reverse().find((m): m is Snap => m.t === 'snapshot');
    expect(armed!.botFinaleAt).toBe(1050 + FINALE_MS); // countdown deadline broadcast

    // Once the window elapses, one bot is crowned and the rest are killed.
    room.tick(1050 + FINALE_MS);
    expect(room.state).toBe('roundEnd');
    const survivors = room.game!.alivePlayers();
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.id).toBe(room.winnerId);
    expect(room.roster.get(room.winnerId!)!.bot).toBe(true);
    expect(room.roster.get(room.winnerId!)!.wins).toBe(1);
  });

  it('ends early if the bots settle to a lone survivor before the window elapses', () => {
    const { room, alice } = botRoom();
    room.game!.killPlayer(alice.id);
    room.tick(1050); // arms the finale, keeps playing
    expect(room.state).toBe('playing');

    // Bots cull each other down to one before the countdown runs out.
    for (const id of room.game!.alivePlayers().slice(1).map((p) => p.id)) {
      room.game!.killPlayer(id);
    }
    room.tick(1100);
    expect(room.state).toBe('roundEnd'); // resolved naturally, not by the timer
    expect(room.game!.alivePlayers()).toHaveLength(1);
    expect(room.winnerId).not.toBeNull();
  });
});

describe('brick keyframes', () => {
  function brickRoom(): Room {
    return new Room('brk01', false, undefined, {
      rng: mulberry32(3),
      brickCandidates: () => [
        {
          id: 'b1',
          size: 2,
          tileUrls: ['/uploads/a.png', '/uploads/b.png'],
          name: 'ACME',
          link: 'https://example.com',
          appearances: 0,
        },
      ],
    });
  }

  /** Drive a ready-checked public room from lobby to its first live snapshot. */
  function startPublic(room: Room, ...players: RosterPlayer[]): void {
    for (const p of players) room.setReady(p.id, p.id, true, 100);
    room.tick(110); // all ready -> countdown
    room.tick(110 + PREMATCH_COUNTDOWN_MS); // countdown elapses -> playing
  }

  it('sends bricks only on the round-start keyframe, then omits them', () => {
    const room = brickRoom();
    const conn = new FakeConn();
    const alice = room.addPlayer('alice', conn, 0);
    const bob = room.addPlayer('bob', new FakeConn(), 50);
    startPublic(room, alice, bob);

    const start = 110 + PREMATCH_COUNTDOWN_MS;
    room.tick(start + 50); // first live snapshot (keyframe)
    const first = conn.last('snapshot');
    expect(first?.t === 'snapshot' && first.bricks !== undefined).toBe(true);

    conn.msgs.length = 0;
    room.tick(start + 100); // ordinary tick: bricks omitted
    const next = conn.last('snapshot');
    expect(next?.t === 'snapshot' && next.bricks).toBeUndefined();
  });

  it('re-sends bricks to a rejoining connection', () => {
    const room = brickRoom();
    const alice = room.addPlayer('alice', new FakeConn(), 0);
    const bob = room.addPlayer('bob', new FakeConn(), 30);
    const carol = room.addPlayer('carol', new FakeConn(), 60);
    startPublic(room, alice, bob, carol);

    const start = 110 + PREMATCH_COUNTDOWN_MS;
    room.tick(start + 50); // burn the round-start keyframe
    room.tick(start + 100);

    // Alice drops and reconnects; bob + carol keep the match live.
    room.handleDisconnect(alice.id, start + 150);
    const conn2 = new FakeConn();
    room.rejoin(alice.id, conn2, start + 200);
    room.tick(start + 250);
    // The keyframe rides the first snapshot the rejoiner sees; a multi-substep
    // tick may append later snapshots that omit bricks, so check for any.
    const gotBricks = conn2.msgs.some((m) => m.t === 'snapshot' && m.bricks !== undefined);
    expect(gotBricks).toBe(true);
  });
});

describe('initial bot fill on lobby creation', () => {
  const countBots = (room: Room): number =>
    [...room.roster.values()].filter((p) => p.bot).length;

  it('seeds half the player cap with bots, leaving room for humans', () => {
    for (const size of [4, 6, 8] as const) {
      const room = new Room('init01', true, undefined, { rng: mulberry32(3), size });
      room.fillInitialBots(0);
      expect(countBots(room)).toBe(Math.floor(size / 2));
      expect(room.hasSlot()).toBe(true); // a human can still join
    }
  });

  it('leaves the seeded bots in place across the lobby (not auto-fill)', () => {
    const room = new Room('init02', true, undefined, { rng: mulberry32(3), size: 8 });
    room.fillInitialBots(0);
    const alice = room.addPlayer('alice', new FakeConn(), 100);
    expect(countBots(room)).toBe(4);
    // Host can still manage them like any manually added bot.
    const bot = [...room.roster.values()].find((p) => p.bot)!;
    room.removeBot(alice.id, bot.id, 200);
    expect(countBots(room)).toBe(3);
  });

  it('is a no-op once the room has left the lobby', () => {
    const room = new Room('init03', true, undefined, { rng: mulberry32(3), size: 8 });
    room.fillInitialBots(0); // 4 bots, enough to start alongside the host
    const alice = room.addPlayer('alice', new FakeConn(), 50);
    hostStart(room, alice.id, 100 + PREMATCH_COUNTDOWN_MS);
    const before = countBots(room);
    room.fillInitialBots(200);
    expect(countBots(room)).toBe(before);
  });
});
