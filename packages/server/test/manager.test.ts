import { describe, expect, it } from 'vitest';
import {
  PREMATCH_COUNTDOWN_MS,
  ROOM_MAX_PLAYERS,
  mulberry32,
  type ServerMessage,
} from '@blastmates/shared';
import { RoomManager } from '../src/manager';
import type { ClientConn, Room } from '../src/room';

class FakeConn implements ClientConn {
  msgs: ServerMessage[] = [];
  send(msg: ServerMessage): void {
    this.msgs.push(msg);
  }
}

function makeManager(): RoomManager {
  return new RoomManager(mulberry32(9));
}

/** Public rooms start via ready check: ready everyone, then run the countdown. */
function startPublic(room: Room, t: number): void {
  for (const p of [...room.roster.values()]) {
    if (!p.bot && p.connected) room.setReady(p.ownerId ?? p.id, p.id, true, t);
  }
  room.tick(t + 10);
  room.tick(t + 10 + PREMATCH_COUNTDOWN_MS);
  expect(room.state).toBe('playing');
}

describe('quick-match slot assignment', () => {
  it('creates a public room when none exists', () => {
    const manager = makeManager();
    const room = manager.quickMatch();
    expect(room.isPrivate).toBe(false);
    expect(manager.rooms.size).toBe(1);
  });

  it('routes the next players into the same room until it is full', () => {
    const manager = makeManager();
    const first = manager.quickMatch();
    first.addPlayer('p1', new FakeConn(), 0);
    for (let i = 2; i <= ROOM_MAX_PLAYERS; i++) {
      const room = manager.quickMatch();
      expect(room).toBe(first);
      room.addPlayer(`p${i}`, new FakeConn(), i);
    }
    // Room is now full: the fifth player gets a new room.
    const overflow = manager.quickMatch();
    expect(overflow).not.toBe(first);
    expect(manager.rooms.size).toBe(2);
  });

  it('never matches players into private rooms', () => {
    const manager = makeManager();
    const priv = manager.createPrivate(8, 'pw');
    priv.addPlayer('host', new FakeConn(), 0);
    const matched = manager.quickMatch();
    expect(matched).not.toBe(priv);
    expect(matched.isPrivate).toBe(false);
  });

  it('prefers rooms that have not started over mid-round rooms', () => {
    const manager = makeManager();
    // Fill a room so it starts playing, then free up slots mid-round.
    const playingRoom = manager.quickMatch();
    const players = Array.from({ length: ROOM_MAX_PLAYERS }, (_, i) =>
      playingRoom.addPlayer(`p${i}`, new FakeConn(), i),
    );
    startPublic(playingRoom, 10);

    // A new waiting room appears while the first room is mid-round.
    const fresh = manager.quickMatch();
    expect(fresh).not.toBe(playingRoom);
    fresh.addPlayer('e', new FakeConn(), 20_000);

    playingRoom.removePlayer(players[2]!.id, 20_100);
    playingRoom.removePlayer(players[3]!.id, 20_100);
    expect(playingRoom.hasSlot()).toBe(true);

    // Both rooms have slots; the waiting room wins over the mid-round one.
    expect(manager.quickMatch()).toBe(fresh);
  });

  it('backfills a mid-round public room when no waiting room exists', () => {
    const manager = makeManager();
    const playingRoom = manager.quickMatch();
    playingRoom.addPlayer('a', new FakeConn(), 0);
    playingRoom.addPlayer('b', new FakeConn(), 0);
    startPublic(playingRoom, 10);

    const matched = manager.quickMatch();
    expect(matched).toBe(playingRoom);
    const late = matched.addPlayer('late', new FakeConn(), 20_000);
    expect(late.spectator).toBe(true); // joins as spectator until next round
  });

  it('removes empty rooms and their tokens', () => {
    const manager = makeManager();
    const room = manager.quickMatch();
    const p = room.addPlayer('solo', new FakeConn(), 0);
    manager.registerToken(p.token, room.id, p.id);
    room.removePlayer(p.id, 100);
    expect(manager.rooms.size).toBe(0);
    expect(manager.lookupToken(p.token)).toBeNull();
  });

  it('resolves rejoin tokens to the right room and player', () => {
    const manager = makeManager();
    const room = manager.quickMatch();
    const p = room.addPlayer('alice', new FakeConn(), 0);
    manager.registerToken(p.token, room.id, p.id);
    const found = manager.lookupToken(p.token);
    expect(found?.room).toBe(room);
    expect(found?.playerId).toBe(p.id);
    expect(manager.lookupToken('bogus')).toBeNull();
  });
});

describe('room size matchmaking', () => {
  it('creates quick-match rooms at the requested size', () => {
    const manager = makeManager();
    expect(manager.quickMatch(6).maxPlayers).toBe(6);
  });

  it('prefers an open room of the requested size over a fuller other-size room', () => {
    const manager = makeManager();
    const big = manager.quickMatch(8);
    big.addPlayer('a', new FakeConn(), 0);
    big.addPlayer('b', new FakeConn(), 100);
    const small = manager.quickMatch(6);
    small.addPlayer('c', new FakeConn(), 200);
    expect(manager.quickMatch(6)).toBe(small);
    expect(manager.quickMatch(8)).toBe(big);
  });

  it('never matches into a different-size room: creates a fresh one instead', () => {
    const manager = makeManager();
    const big = manager.quickMatch(8);
    big.addPlayer('a', new FakeConn(), 0);
    const matched = manager.quickMatch(4);
    expect(matched).not.toBe(big);
    expect(matched.maxPlayers).toBe(4);
  });

  it('creates private rooms at the requested size', () => {
    const manager = makeManager();
    expect(manager.createPrivate(4).maxPlayers).toBe(4);
    expect(manager.createPrivate(8, 'pw').maxPlayers).toBe(8);
  });
});
