import {
  DEFAULT_ROOM,
  type Intent,
  type IntentMessage,
  type ServerMessage,
} from '@deliberate/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectFixture, useFixtureMode } from './transport.js';

function harness() {
  const messages: ServerMessage[] = [];
  const statuses: string[] = [];
  const transport = connectFixture({
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
  });
  vi.advanceTimersByTime(0);
  return { messages, statuses, transport };
}

function intent(inner: Intent): IntentMessage {
  return { type: 'intent', room: DEFAULT_ROOM, turn: 0, intent: inner };
}

describe('fixture transport', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a snapshot first, then the scripted turns in order, then narrates', () => {
    const { messages, statuses, transport } = harness();
    expect(statuses[0]).toBe('fixture');
    expect(messages[0]?.type).toBe('snapshot');

    vi.advanceTimersByTime(10_000);
    const types = messages.map((m) => m.type);
    expect(types[0]).toBe('snapshot');
    expect(types.slice(1)).toEqual(['diffs', 'diffs', 'diffs', 'narration', 'narration']);
    const turns = messages.flatMap((m) => (m.type === 'diffs' ? [m.turn] : []));
    expect(turns).toEqual([1, 2, 3]);
    // Streamed, and sealed exactly once, which is what tells the thread the block is finished.
    const narration = messages.flatMap((m) => (m.type === 'narration' ? [m] : []));
    expect(narration.map((m) => m.done)).toEqual([false, true]);
    expect(narration.map((m) => m.chunk).join('')).toContain('Straw');
    transport.close();
  });

  it('answers a legal move with an EntityMoved diff whose path steps one tile at a time', () => {
    const { messages, transport } = harness();
    messages.length = 0;
    transport.send(intent({ kind: 'move', entity: 'player', to: { x: 4, y: 4 } }));
    const message = messages[0];
    expect(message?.type).toBe('diffs');
    if (message?.type !== 'diffs') throw new Error('expected diffs');
    const diff = message.diffs[0];
    if (diff?.type !== 'EntityMoved') throw new Error('expected EntityMoved');
    expect(diff.from).toEqual({ x: 2, y: 2 });
    expect(diff.to).toEqual({ x: 4, y: 4 });
    expect(diff.path).toEqual([
      { x: 3, y: 3 },
      { x: 4, y: 4 },
    ]);
    transport.close();
  });

  it('rejects illegal moves with a reason a player could read', () => {
    const { messages, transport } = harness();
    const reasons: string[] = [];
    const drain = () => {
      for (const m of messages) if (m.type === 'error') reasons.push(m.reason);
      messages.length = 0;
    };

    transport.send(intent({ kind: 'move', entity: 'player', to: { x: 0, y: 0 } }));
    drain();
    transport.send(intent({ kind: 'move', entity: 'player', to: { x: 10, y: 8 } }));
    drain();
    transport.send(intent({ kind: 'move', entity: 'player', to: { x: 2, y: 2 } }));
    drain();
    transport.send(intent({ kind: 'move', entity: 'nobody', to: { x: 3, y: 3 } }));
    drain();

    expect(reasons).toHaveLength(4);
    expect(reasons[0]).toMatch(/not walkable/);
    expect(reasons[1]).toMatch(/too far/);
    expect(reasons[2]).toMatch(/already there/);
    expect(reasons[3]).toMatch(/no such entity/);
    transport.close();
  });

  it('needs the attacker to be adjacent, then applies deterministic damage', () => {
    const { messages, transport } = harness();
    messages.length = 0;

    transport.send(
      intent({ kind: 'attack', attacker: 'player', target: 'dummy-a', ability: 'longsword' }),
    );
    expect(messages[0]).toMatchObject({
      type: 'error',
      reason: expect.stringMatching(/out of reach/),
    });

    messages.length = 0;
    transport.send(intent({ kind: 'move', entity: 'player', to: { x: 7, y: 3 } }));
    messages.length = 0;
    transport.send(
      intent({ kind: 'attack', attacker: 'player', target: 'dummy-a', ability: 'longsword' }),
    );
    const message = messages[0];
    if (message?.type !== 'diffs') throw new Error('expected diffs');
    expect(message.diffs[0]).toMatchObject({
      type: 'DamageApplied',
      target: 'dummy-a',
      hpAfter: 7,
    });
    transport.close();
  });

  it('goes quiet once closed', () => {
    const { messages, transport } = harness();
    transport.close();
    messages.length = 0;
    vi.advanceTimersByTime(10_000);
    transport.send(intent({ kind: 'move', entity: 'player', to: { x: 3, y: 3 } }));
    expect(messages).toEqual([]);
  });
});

describe('useFixtureMode', () => {
  it('reads ?fixture=1 or #fixture', () => {
    expect(useFixtureMode('?fixture=1')).toBe(true);
    expect(useFixtureMode('', '#fixture')).toBe(true);
    expect(useFixtureMode('?fixture=0')).toBe(false);
    expect(useFixtureMode('')).toBe(false);
  });
});
