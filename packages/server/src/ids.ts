import { randomBytes } from 'node:crypto';

const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function randomRoomId(length = 6): string {
  const bytes = randomBytes(length);
  let id = '';
  for (let i = 0; i < length; i++) {
    id += ROOM_ALPHABET[(bytes[i] ?? 0) % ROOM_ALPHABET.length];
  }
  return id;
}

export function randomToken(): string {
  return randomBytes(16).toString('hex');
}

let counter = 0;
export function nextEntityId(prefix: string): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}${counter}`;
}
