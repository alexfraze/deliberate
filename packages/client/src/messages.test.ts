import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ServerMessage } from '@deliberate/protocol';

import { SERVER_MESSAGE_TYPES, encodeClientMessage, parseServerMessage } from './messages.js';

describe('parseServerMessage', () => {
  /**
   * The allow-list is the client's front door, and a frame type left out of it is dropped in
   * silence — which is correct for a hostile socket and a trap for a new frame. ALE-52 fell into
   * exactly that trap: `abandoned` was added to the protocol, the server sent it, and the client
   * threw it away without a word. This is the check that makes the next one a red test instead.
   */
  it('lets through every server frame the protocol defines, and nothing else', () => {
    // Equality, not assignability: a frame the protocol defines and this list omits fails here.
    expectTypeOf<(typeof SERVER_MESSAGE_TYPES)[number]>().toEqualTypeOf<ServerMessage['type']>();
    expect(new Set(SERVER_MESSAGE_TYPES).size).toBe(SERVER_MESSAGE_TYPES.length);
    for (const type of SERVER_MESSAGE_TYPES) {
      expect(parseServerMessage(JSON.stringify({ type, room: 'main', turn: 0 }))).not.toBeNull();
    }
  });

  it('accepts known server messages', () => {
    const msg = parseServerMessage(
      JSON.stringify({ type: 'error', room: 'main', turn: null, reason: 'nope' }),
    );
    expect(msg).toEqual({ type: 'error', room: 'main', turn: null, reason: 'nope' });
  });

  it('rejects garbage and unknown types', () => {
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage('42')).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'intent' }))).toBeNull();
  });
});

describe('encodeClientMessage', () => {
  it('round-trips through JSON', () => {
    const raw = encodeClientMessage({ type: 'join', room: 'main', protocol: 1 });
    expect(JSON.parse(raw)).toEqual({ type: 'join', room: 'main', protocol: 1 });
  });
});
