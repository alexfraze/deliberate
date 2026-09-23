import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '@deliberate/protocol';

import { isIntent, parseClientFrame, toText } from './frames.js';

const frame = (value: unknown): ReturnType<typeof parseClientFrame> =>
  parseClientFrame(JSON.stringify(value));

describe('parseClientFrame', () => {
  it('accepts a join at the current protocol version', () => {
    const result = frame({ type: 'join', room: 'main', protocol: PROTOCOL_VERSION });
    expect(result).toEqual({
      ok: true,
      message: { type: 'join', room: 'main', protocol: PROTOCOL_VERSION },
    });
  });

  it('accepts each M0 intent', () => {
    expect(
      frame({
        type: 'intent',
        room: 'main',
        turn: 0,
        intent: { kind: 'move', entity: 'p', to: { x: 1, y: 2 } },
      }).ok,
    ).toBe(true);
    expect(
      frame({
        type: 'intent',
        room: 'main',
        turn: 3,
        intent: { kind: 'attack', attacker: 'p', target: 'd', ability: 'longsword' },
      }).ok,
    ).toBe(true);
    expect(
      frame({ type: 'intent', room: 'main', turn: 0, intent: { kind: 'end_turn', entity: 'p' } })
        .ok,
    ).toBe(true);
  });

  it.each([
    ['not json', 'not json at all'],
    ['a bare array', JSON.stringify([1, 2, 3])],
    ['a missing room', JSON.stringify({ type: 'join', protocol: PROTOCOL_VERSION })],
    ['an unknown type', JSON.stringify({ type: 'shout', room: 'main' })],
    ['an old protocol', JSON.stringify({ type: 'join', room: 'main', protocol: 0 })],
    [
      'a missing turn',
      JSON.stringify({ type: 'intent', room: 'main', intent: { kind: 'end_turn', entity: 'p' } }),
    ],
    [
      'a fractional turn',
      JSON.stringify({
        type: 'intent',
        room: 'main',
        turn: 1.5,
        intent: { kind: 'end_turn', entity: 'p' },
      }),
    ],
    [
      'a non-integer tile',
      JSON.stringify({
        type: 'intent',
        room: 'main',
        turn: 0,
        intent: { kind: 'move', entity: 'p', to: { x: 1.5, y: 2 } },
      }),
    ],
    [
      'an unknown intent kind',
      JSON.stringify({ type: 'intent', room: 'main', turn: 0, intent: { kind: 'teleport' } }),
    ],
  ])('refuses %s with a readable reason', (_label, text) => {
    const result = parseClientFrame(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe('isIntent', () => {
  it('accepts the two ALE-31 intents a player composes', () => {
    expect(isIntent({ kind: 'cast', caster: 'p', spell: 'fire-bolt', target: 'd' })).toBe(true);
    expect(isIntent({ kind: 'say', speaker: 'p', text: 'Hail.', to: 'guard' })).toBe(true);
    expect(isIntent({ kind: 'say', speaker: 'p', text: 'Hail.', to: null })).toBe(true);
    expect(isIntent({ kind: 'say', speaker: 'p', text: '', to: null })).toBe(false);
    expect(isIntent({ kind: 'say', speaker: 'p', text: 'x'.repeat(2_001), to: null })).toBe(false);
    expect(isIntent({ kind: 'cast', caster: 'p', spell: 'fire-bolt' })).toBe(false);
  });

  /**
   * The authority boundary, not a shape check. The engine validates whether a `spawn` names a real
   * template; it has no idea who asked, by design. So "a person at a keyboard may not author the
   * world" is enforced by never parsing these four off a socket — they reach the engine only as
   * tool calls on `POST /gm/tool`.
   */
  it.each(['set_disposition', 'spawn', 'set_flag', 'advance_quest'])(
    'refuses the world-authoring intent %s off the wire',
    (kind) => {
      expect(
        isIntent({
          kind,
          entity: 'guard',
          toward: 'player',
          delta: 100,
          reason: 'because I said so',
          template: 'guard',
          at: { x: 1, y: 1 },
          map: null,
          id: null,
          key: 'gatehouse.gate.sealed',
          value: false,
          quest: 'carry-the-scout',
          step: 3,
        }),
      ).toBe(false);
    },
  );

  it('rejects anything that is not a shaped M0 intent', () => {
    expect(isIntent(null)).toBe(false);
    expect(isIntent({ kind: 'move', entity: '', to: { x: 0, y: 0 } })).toBe(false);
    expect(isIntent({ kind: 'move', entity: 'p' })).toBe(false);
    expect(isIntent({ kind: 'attack', attacker: 'p', target: 'd' })).toBe(false);
  });
});

describe('toText', () => {
  it('decodes the shapes ws can hand over', () => {
    expect(toText('hi')).toBe('hi');
    expect(toText(Buffer.from('hi'))).toBe('hi');
    expect(toText([Buffer.from('h'), Buffer.from('i')])).toBe('hi');
    expect(toText(new TextEncoder().encode('hi').buffer)).toBe('hi');
  });
});

describe('pass_time on the wire (ALE-41)', () => {
  it('is a player intent, so a Wait button can send one', () => {
    const result = parseClientFrame(
      JSON.stringify({
        type: 'preview_request',
        room: 'main',
        turn: 0,
        intent: { kind: 'pass_time', entity: 'player' },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('still needs somebody to be doing the waiting', () => {
    const result = parseClientFrame(
      JSON.stringify({
        type: 'intent',
        room: 'main',
        turn: 0,
        intent: { kind: 'pass_time' },
      }),
    );
    expect(result).toMatchObject({ ok: false });
  });

  /**
   * The four world-authoring kinds are the game master's alone, and adding a player verb must not
   * quietly open that door. Found by playing: every unit test above this one hands the room an
   * already-parsed message, so the wire's own allowlist was the one thing they could not check.
   */
  it('does not let a new player verb reopen the world-authoring kinds', () => {
    for (const intent of [
      { kind: 'spawn', template: 'guard', at: { x: 1, y: 1 }, map: null, id: null },
      { kind: 'set_flag', key: 'gatehouse.gate.sealed', value: false },
      { kind: 'advance_quest', quest: 'carry-the-scout', step: 2 },
      {
        kind: 'set_disposition',
        entity: 'gate-guard-halloran',
        toward: 'player',
        delta: 50,
        reason: 'x',
      },
    ]) {
      const result = parseClientFrame(
        JSON.stringify({ type: 'intent', room: 'main', turn: 0, intent }),
      );
      expect(result, intent.kind).toMatchObject({ ok: false });
    }
  });
});

describe('traverse on the wire (ALE-43)', () => {
  it('is a player intent: walking through a door is movement', () => {
    for (const to of [null, 'm1-postern-lane']) {
      const result = parseClientFrame(
        JSON.stringify({
          type: 'intent',
          room: 'main',
          turn: 0,
          intent: { kind: 'traverse', entity: 'player', to },
        }),
      );
      expect(result.ok, JSON.stringify(to)).toBe(true);
    }
  });

  it('refuses one with nobody walking, or a destination that is not an id', () => {
    for (const intent of [
      { kind: 'traverse', to: null },
      { kind: 'traverse', entity: 'player' },
      { kind: 'traverse', entity: 'player', to: 7 },
      { kind: 'traverse', entity: 'player', to: '' },
    ]) {
      const result = parseClientFrame(
        JSON.stringify({ type: 'intent', room: 'main', turn: 0, intent }),
      );
      expect(result, JSON.stringify(intent)).toMatchObject({ ok: false });
    }
  });
});
