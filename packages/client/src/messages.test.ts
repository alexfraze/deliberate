import { describe, expect, it } from 'vitest';

import { encodeClientMessage, parseServerMessage } from './messages.js';

describe('parseServerMessage', () => {
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
