import { describe, expect, it } from 'vitest';
import {
  parseClientMessage,
  parseServerMessage,
  ServerMessageSchema,
  type ServerMessage,
} from '../src/index';

describe('client message parsing', () => {
  it('accepts a valid quick-match join', () => {
    const msg = parseClientMessage(
      JSON.stringify({ t: 'join', nickname: 'alice', mode: { kind: 'quick' } }),
    );
    expect(msg).toEqual({ t: 'join', nickname: 'alice', mode: { kind: 'quick' } });
  });

  it('accepts join with room id and password', () => {
    const msg = parseClientMessage(
      JSON.stringify({
        t: 'join',
        nickname: 'bob',
        mode: { kind: 'join', roomId: 'abc123', password: 'hunter2' },
      }),
    );
    expect(msg?.t).toBe('join');
  });

  it('accepts brick view/click engagement events and rejects bad kinds', () => {
    const view = parseClientMessage(JSON.stringify({ t: 'brickEvent', id: 'brick1', kind: 'view' }));
    expect(view).toEqual({ t: 'brickEvent', id: 'brick1', kind: 'view' });
    expect(parseClientMessage(JSON.stringify({ t: 'brickEvent', id: 'brick1', kind: 'click' }))?.t).toBe(
      'brickEvent',
    );
    expect(parseClientMessage(JSON.stringify({ t: 'brickEvent', id: 'brick1', kind: 'tap' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'brickEvent', id: '', kind: 'view' }))).toBeNull();
  });

  it('validates skin choices against the legal catalog', () => {
    const withSkin = parseClientMessage(
      JSON.stringify({
        t: 'join',
        nickname: 'eve',
        mode: { kind: 'quick' },
        skin: { palette: 'gold', hat: 'tophat', dance: 'bounce' },
      }),
    );
    expect(withSkin && withSkin.t === 'join' ? withSkin.skin?.palette : null).toBe('gold');
    expect(
      parseClientMessage(
        JSON.stringify({
          t: 'join',
          nickname: 'eve',
          mode: { kind: 'quick' },
          skin: { palette: 'neon-hax', hat: 'none', dance: 'classic' },
        }),
      ),
    ).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({
          t: 'join',
          nickname: 'eve',
          mode: { kind: 'quick' },
          skin: { palette: 'default', hat: 'sombrero', dance: 'classic' },
        }),
      ),
    ).toBeNull();
  });

  it('accepts ready toggle messages, with an optional local player target', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'ready', ready: true }))).toEqual({
      t: 'ready',
      ready: true,
    });
    expect(parseClientMessage(JSON.stringify({ t: 'ready', ready: false, pid: 'p1' }))).toEqual({
      t: 'ready',
      ready: false,
      pid: 'p1',
    });
    expect(parseClientMessage(JSON.stringify({ t: 'ready' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'ready', ready: 'yes' }))).toBeNull();
  });

  it('accepts input and bomb messages', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'input', dir: 'left' }))).toEqual({
      t: 'input',
      dir: 'left',
    });
    expect(parseClientMessage(JSON.stringify({ t: 'input', dir: null }))).toEqual({
      t: 'input',
      dir: null,
    });
    expect(parseClientMessage(JSON.stringify({ t: 'bomb' }))).toEqual({ t: 'bomb' });
  });

  it('accepts host kick messages', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'kick', playerId: 'p1' }))).toEqual({
      t: 'kick',
      playerId: 'p1',
    });
    expect(parseClientMessage(JSON.stringify({ t: 'kick' }))).toBeNull();
  });

  it('rejects malformed payloads', () => {
    expect(parseClientMessage('not json')).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'nope' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'input', dir: 'diagonal' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'join', nickname: '', mode: { kind: 'quick' } }))).toBeNull();
    expect(
      parseClientMessage(
        JSON.stringify({ t: 'join', nickname: 'x'.repeat(40), mode: { kind: 'quick' } }),
      ),
    ).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'join', nickname: 'a', mode: { kind: 'join' } }))).toBeNull();
  });

  it('trims nicknames', () => {
    const msg = parseClientMessage(
      JSON.stringify({ t: 'join', nickname: '  alice  ', mode: { kind: 'quick' } }),
    );
    expect(msg && msg.t === 'join' ? msg.nickname : null).toBe('alice');
  });
});

describe('server message parsing', () => {
  it('round-trips a snapshot message', () => {
    const snapshot: ServerMessage = {
      t: 'snapshot',
      tick: 12,
      serverTime: 1000,
      grid: '.'.repeat(195),
      players: [
        { id: 'p1', x: 0.5, y: 0.5, dir: 'right', alive: true, bombCap: 1, range: 2, speed: 3 },
      ],
      bombs: [{ id: 'b1', x: 3, y: 4, ownerId: 'p1', explodesAt: 4000 }],
      explosions: [{ id: 'e1', cells: [{ x: 1, y: 1 }], endsAt: 1500 }],
      powerups: [{ id: 'u1', x: 2, y: 2, kind: 'range' }],
      bricks: [
        { id: 'br1', x: 2, y: 0, tiles: ['/uploads/br1/tile-0.png'], name: 'ACME', link: null },
      ],
    };
    expect(parseServerMessage(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('validates room messages', () => {
    const room: ServerMessage = {
      t: 'room',
      roomId: 'r1',
      roomName: 'SPICY BUNKER',
      state: 'countdown',
      isPrivate: false,
      hostId: null,
      maxPlayers: 4,
      countdownEndsAt: 99,
      winnerId: null,
      readyTimerEndsAt: 60_000,
      serverTime: 50,
      players: [
        { id: 'p1', nickname: 'alice', connected: true, spectator: false, ready: true, wins: 0 },
      ],
    };
    expect(ServerMessageSchema.safeParse(room).success).toBe(true);
    expect(parseServerMessage(JSON.stringify({ t: 'room' }))).toBeNull();
    // readyTimerEndsAt is required on room messages
    const { readyTimerEndsAt: _readyTimer, ...withoutTimer } = room;
    expect(ServerMessageSchema.safeParse(withoutTimer).success).toBe(false);
  });
});
