import { describe, expect, it } from 'vitest';
import {
  PREMATCH_COUNTDOWN_MS,
  ROOM_MAX_PLAYERS,
  mulberry32,
  type ServerMessage,
} from '@blastmates/shared';
import { RoomManager } from '../src/manager';
import { RateLimiter } from '../src/ratelimit';
import { Room, type ClientConn } from '../src/room';

class FakeConn implements ClientConn {
  msgs: ServerMessage[] = [];
  send(msg: ServerMessage): void {
    this.msgs.push(msg);
  }
}

function makeManager(): RoomManager {
  return new RoomManager(mulberry32(7));
}

function startPublic(room: Room, t: number): void {
  for (const p of [...room.roster.values()]) {
    if (!p.bot && p.connected) room.setReady(p.ownerId ?? p.id, p.id, true, t);
  }
  room.tick(t + 10);
  room.tick(t + 10 + PREMATCH_COUNTDOWN_MS);
  expect(room.state).toBe('playing');
}

describe('room previews', () => {
  it('describes a private room without revealing the password', () => {
    const manager = makeManager();
    const room = manager.createPrivate(8, 'hunter2');
    room.addPlayer('host', new FakeConn(), 0);
    const info = manager.roomInfo(room.id);
    expect(info).toMatchObject({
      roomId: room.id,
      isPrivate: true,
      passwordRequired: true,
      status: 'lobby',
      players: 1,
      maxPlayers: ROOM_MAX_PLAYERS,
      humans: 1,
      bots: 0,
      joinable: true,
    });
    expect(JSON.stringify(info)).not.toContain('hunter2');
  });

  it('returns null for unknown rooms', () => {
    expect(makeManager().roomInfo('nope42')).toBeNull();
  });

  it('gives rooms cool two-word names, unique among live rooms', () => {
    const manager = makeManager();
    const names = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const room = manager.createPrivate();
      room.addPlayer(`p${i}`, new FakeConn(), i);
      expect(room.name).toMatch(/^[A-Z]+ [A-Z]+$/);
      expect(manager.roomInfo(room.id)?.name).toBe(room.name);
      names.add(room.name);
    }
    expect(names.size).toBe(10);
  });

  it('reports in_match status and bot counts', () => {
    const manager = makeManager();
    const room = manager.quickMatch();
    room.addPlayer('a', new FakeConn(), 0);
    const b = room.addPlayer('b', new FakeConn(), 0);
    room.addBot(b.id, 0);
    startPublic(room, 10);
    const info = manager.roomInfo(room.id);
    expect(info?.status).toBe('in_match');
    expect(info?.bots).toBe(1);
    expect(info?.humans).toBe(2);
  });

  it('marks a full public lobby with bots as joinable (bot displacement)', () => {
    const manager = makeManager();
    const room = manager.quickMatch();
    const first = room.addPlayer('a', new FakeConn(), 0);
    let t = 0;
    while (room.hasSlot()) room.addBot(first.id, (t += 100_000));
    expect(manager.roomInfo(room.id)?.joinable).toBe(true);
  });

  it('marks a full private room as not joinable', () => {
    const manager = makeManager();
    const room = manager.createPrivate();
    for (let i = 0; i < ROOM_MAX_PLAYERS; i++) room.addPlayer(`p${i}`, new FakeConn(), i);
    expect(manager.roomInfo(room.id)?.joinable).toBe(false);
  });
});

describe('public room listing', () => {
  it('lists only public rooms with humans', () => {
    const manager = makeManager();
    const pub = manager.quickMatch();
    pub.addPlayer('alice', new FakeConn(), 0);
    const priv = manager.createPrivate(8, 'pw');
    priv.addPlayer('bob', new FakeConn(), 0);
    manager.quickMatch(); // empty public room: no humans, not listed

    const listed = manager.listPublicRooms();
    expect(listed.map((r) => r.roomId)).toEqual([pub.id]);
  });

  it('sorts joinable lobbies with the most humans first', () => {
    const manager = makeManager();
    // Insert rooms directly: quickMatch would funnel everyone into one room.
    const addPublicRoom = (id: string): Room => {
      const room = new Room(id, false, undefined, { rng: mulberry32(1) });
      manager.rooms.set(id, room);
      return room;
    };

    const playing = addPublicRoom('aplay1');
    playing.addPlayer('a', new FakeConn(), 0);
    playing.addPlayer('b', new FakeConn(), 0);
    startPublic(playing, 10);

    const small = addPublicRoom('bsmall1');
    small.addPlayer('c', new FakeConn(), 20_000);

    const big = addPublicRoom('cbig11');
    big.addPlayer('d', new FakeConn(), 20_000);
    big.addPlayer('e', new FakeConn(), 20_000);

    const order = manager.listPublicRooms().map((r) => r.roomId);
    expect(order).toEqual([big.id, small.id, playing.id]);
  });
});

describe('password attempt rate limiting', () => {
  it('blocks after the limit within the window and resets after it', () => {
    const limiter = new RateLimiter(5, 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(limiter.blocked('1.2.3.4', t0 + i)).toBe(false);
      limiter.allow('1.2.3.4', t0 + i);
    }
    expect(limiter.blocked('1.2.3.4', t0 + 10)).toBe(true);
    expect(limiter.blocked('5.6.7.8', t0 + 10)).toBe(false); // other IPs unaffected
    expect(limiter.blocked('1.2.3.4', t0 + 60_001)).toBe(false); // window expired
  });
});
