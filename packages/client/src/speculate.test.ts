import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Intent } from '@deliberate/protocol';

import { DWELL_MS, createSpeculator, type SpeculatorOptions } from './speculate.js';

/**
 * ALE-40's evidence on the client half: **the chooser spends money only on a pointer that has
 * stopped, and never twice on the same question.**
 *
 * These are money tests, not behaviour tests. Every `send` here is a model call in production, so
 * what is asserted is mostly the calls that must NOT happen — sweeping the pointer across the map,
 * hovering the same tile again, hovering a third thing after the budget is gone.
 */

const move = (x: number): Intent => ({ kind: 'move', entity: 'pc', to: { x, y: 0 } });

function harness(options: Partial<SpeculatorOptions> = {}) {
  const sent: Intent[] = [];
  const speculator = createSpeculator({ send: (intent) => sent.push(intent), ...options });
  return { sent, speculator };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the speculative preview chooser', () => {
  it('sends nothing for a pointer that is merely passing through', () => {
    const h = harness();
    h.speculator.turn(0);
    for (let x = 0; x < 20; x++) {
      h.speculator.hover(move(x));
      vi.advanceTimersByTime(DWELL_MS / 4);
    }
    expect(h.sent, 'a pointer sweeping the map spent money').toHaveLength(0);
  });

  it('sends one frame once the pointer has rested', () => {
    const h = harness();
    h.speculator.turn(0);
    h.speculator.hover(move(3));
    expect(h.sent).toHaveLength(0);
    vi.advanceTimersByTime(DWELL_MS);
    expect(h.sent).toEqual([move(3)]);
  });

  it('does not restart the clock when the same target is hovered again', () => {
    // A hand resting on a tile still fires pointermove. If each one rearmed the timer, a slightly
    // unsteady pointer would never dwell long enough to speculate at all.
    const h = harness();
    h.speculator.turn(0);
    for (let i = 0; i < 10; i++) {
      h.speculator.hover(move(3));
      vi.advanceTimersByTime(DWELL_MS / 5);
    }
    expect(h.sent).toEqual([move(3)]);
  });

  it('never pays twice for the same intent in one turn', () => {
    const h = harness();
    h.speculator.turn(0);
    h.speculator.hover(move(3));
    vi.advanceTimersByTime(DWELL_MS);
    h.speculator.hover(null);
    h.speculator.hover(move(3));
    vi.advanceTimersByTime(DWELL_MS * 3);
    expect(h.sent).toHaveLength(1);
  });

  it('stops at the per-turn ceiling and starts again on the next turn', () => {
    const h = harness();
    h.speculator.turn(0);
    for (const x of [1, 2, 3, 4, 5]) {
      h.speculator.hover(move(x));
      vi.advanceTimersByTime(DWELL_MS);
    }
    expect(h.sent, 'the pointer spent more than its allowance').toHaveLength(2);

    // A committed turn is a different world: every cached key changed, so the budget resets.
    h.speculator.turn(1);
    h.speculator.hover(move(9));
    vi.advanceTimersByTime(DWELL_MS);
    expect(h.sent).toHaveLength(3);
    expect(h.speculator.stats()).toEqual({ sent: 1, armed: false, turn: 1 });
  });

  it('disarms on a null hover, on cancel, and on a new turn', () => {
    const h = harness();
    h.speculator.turn(0);

    h.speculator.hover(move(1));
    h.speculator.hover(null);
    vi.advanceTimersByTime(DWELL_MS * 2);

    h.speculator.hover(move(2));
    h.speculator.cancel();
    vi.advanceTimersByTime(DWELL_MS * 2);

    h.speculator.hover(move(3));
    h.speculator.turn(1);
    vi.advanceTimersByTime(DWELL_MS * 2);

    expect(h.sent).toHaveLength(0);
  });

  it('is a no-op when it is switched off', () => {
    const h = harness({ enabled: false });
    h.speculator.turn(0);
    h.speculator.hover(move(1));
    vi.advanceTimersByTime(DWELL_MS * 10);
    expect(h.sent).toHaveLength(0);
  });
});
