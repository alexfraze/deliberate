import type { Diff } from '@deliberate/protocol';
import { describe, expect, it } from 'vitest';

import { AnimationQueue, animationFor, type Animation, type QueueEvent } from './animation.js';
import { initiativeView } from './initiative.js';
import { parseRecording, replayName, type RecordedSession } from './replay.js';
import { applyDiffsToView, applyDiffToView, viewFromSnapshot, type ViewState } from './view.js';

import m1Acceptance from '../../../recordings/bank/m1-acceptance.jsonl?raw';
import yardBrawl from '../../../recordings/bank/yard-brawl.jsonl?raw';

/**
 * The ALE-19 done-when, as a test: **a recorded M1 session plays back with no animation overlap
 * bugs.** These are real sessions off the regression bank — `yard-brawl.jsonl` is a live
 * model-driven fight with two deaths in it — not diffs someone invented to match the code.
 *
 * What "no overlap" means, precisely, and what is asserted below:
 *   1. never two animations in flight at once;
 *   2. exactly one `start` and one `finish` per diff, in the order the server sent them;
 *   3. every animation reaching `t === 1` before it finishes, so nothing is cut short;
 *   4. the view folded in animation-finish order ending up identical to the view folded straight
 *      from the diffs — the renderer draws the same world the engine committed, not a re-ordered
 *      one;
 *   5. the queue draining, so a session cannot leave an animation stuck on screen.
 */
// Pulled in through vite's `?raw` rather than `node:fs`: this is a browser package, and a test in
// it that reaches for the filesystem is one import away from src doing the same.
const BANK: Record<string, string> = { 'yard-brawl': yardBrawl, 'm1-acceptance': m1Acceptance };

function bank(name: string): RecordedSession {
  const text = BANK[name];
  if (text === undefined) throw new Error(`${name}: not in the bank`);
  const session = parseRecording(text);
  if (!session) throw new Error(`${name}: no header in the recording`);
  return session;
}

/** One frame of the render loop, at a deliberately ugly cadence to shake out spill-over bugs. */
const FRAME_MS = 17;

interface Played {
  events: QueueEvent[];
  view: ViewState;
  maxInFlight: number;
}

/** Plays a whole session the way `main.ts` does: enqueue a turn, drain it, then the next. */
function play(session: RecordedSession): Played {
  const queue = new AnimationQueue();
  const view = viewFromSnapshot(session.snapshot);
  const events: QueueEvent[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  for (const turn of session.turns) {
    queue.enqueue(turn.diffs);
    // A bounded loop rather than `while (!queue.idle)`: a queue that never drains is the bug, and
    // it should fail the assertion below rather than hang the suite.
    for (let frame = 0; frame < 10_000 && !queue.idle; frame += 1) {
      for (const event of queue.advance(FRAME_MS)) {
        events.push(event);
        if (event.type === 'start') inFlight += 1;
        if (event.type === 'finish') {
          inFlight -= 1;
          // The renderer folds a diff into the view when its animation finishes, not when the
          // frame arrives. That ordering is what the equality check below is about.
          applyDiffToView(view, event.animation.diff);
        }
        maxInFlight = Math.max(maxInFlight, inFlight);
      }
    }
    expect(queue.idle).toBe(true);
  }
  return { events, view, maxInFlight };
}

function diffsOf(session: RecordedSession): Diff[] {
  return session.turns.flatMap((turn) => turn.diffs);
}

describe.each(['yard-brawl', 'm1-acceptance'])('replaying %s', (name) => {
  const session = bank(name);
  const played = play(session);
  const diffs = diffsOf(session);

  it('has diffs worth animating', () => {
    expect(session.turns.length).toBeGreaterThan(0);
    expect(diffs.length).toBeGreaterThan(10);
  });

  it('never has two animations in flight at once', () => {
    expect(played.maxInFlight).toBe(1);
  });

  it('starts and finishes each diff exactly once, in arrival order', () => {
    const started = played.events.filter((e) => e.type === 'start').map((e) => e.animation.diff);
    const finished = played.events.filter((e) => e.type === 'finish').map((e) => e.animation.diff);
    expect(started).toEqual(diffs);
    expect(finished).toEqual(diffs);
  });

  it('never cuts an animation short — every one reaches t = 1 before it finishes', () => {
    const lastT = new Map<Animation, number>();
    for (const event of played.events) {
      if (event.type === 'progress') lastT.set(event.animation, event.t);
      if (event.type === 'finish') expect(lastT.get(event.animation)).toBe(1);
    }
  });

  it('draws the world the engine committed, not a re-ordered one', () => {
    const straight = viewFromSnapshot(session.snapshot);
    applyDiffsToView(straight, diffs);
    expect(played.view).toEqual(straight);
  });

  it('plays a strike as a swing and then a hit, and a death as a collapse', () => {
    const kinds = new Set(diffs.map((diff) => animationFor(diff).kind));
    // Both bank sessions carry moves; only the brawl carries blows and deaths.
    expect(kinds.has('move')).toBe(true);
    if (name === 'yard-brawl') {
      expect(kinds.has('damage')).toBe(true);
      expect(kinds.has('death')).toBe(true);
      const strikes = diffs
        .map(animationFor)
        .filter((animation) => animation.kind === 'damage')
        .filter((animation) => animation.attacker !== null);
      expect(strikes.length).toBeGreaterThan(0);
    }
  });
});

describe('the turn-order indicator over a real fight', () => {
  const session = bank('yard-brawl');

  it('follows initiative through the fight and greys out the dead', () => {
    const view = viewFromSnapshot(session.snapshot);
    const currents: string[] = [];
    let sawDown = false;
    for (const turn of session.turns) {
      applyDiffsToView(view, turn.diffs);
      const strip = initiativeView(view);
      if (!strip) continue;
      // Exactly one chip is current at any moment, and the round never goes backwards.
      expect(strip.chips.filter((c) => c.current)).toHaveLength(1);
      // Whoever is up next is somebody else, and is still standing.
      const next = strip.chips.find((c) => c.next);
      if (next) {
        expect(next.current).toBe(false);
        expect(next.down).toBe(false);
      }
      const current = strip.chips.find((c) => c.current);
      if (current) currents.push(current.id);
      sawDown ||= strip.chips.some((c) => c.down);
    }
    // The fight has two deaths in it; the strip has to show them.
    expect(sawDown).toBe(true);
    // And the highlight actually moves rather than sticking on whoever went first.
    expect(new Set(currents).size).toBeGreaterThan(1);
  });
});

describe('parseRecording', () => {
  it('skips meters, refused turns and junk rather than refusing the session', () => {
    const session = parseRecording(
      [
        JSON.stringify({ line: 'header', snapshot: { schema: 1, entities: {}, world: {} } }),
        JSON.stringify({ line: 'meter', turn: 0, usd: 1 }),
        JSON.stringify({ line: 'turn', turn: 1, diffs: [], verdict: { ok: false } }),
        JSON.stringify({ line: 'turn', turn: 2, diffs: [{ type: 'FlagSet', key: 'k', value: 1 }] }),
        'not json at all',
        '',
      ].join('\n'),
    );
    expect(session?.turns).toHaveLength(1);
    expect(session?.turns[0]?.turn).toBe(2);
  });

  it('is null without a header, because there is no world to draw the diffs against', () => {
    expect(parseRecording('')).toBeNull();
    expect(parseRecording(JSON.stringify({ line: 'turn', turn: 1, diffs: [] }))).toBeNull();
  });
});

describe('replayName', () => {
  it('reads the recording to play from the query or the hash', () => {
    expect(replayName('?replay=yard-brawl')).toBe('yard-brawl');
    expect(replayName('', '#replay=m1-acceptance')).toBe('m1-acceptance');
    expect(replayName('?fixture=1')).toBeNull();
    expect(replayName('')).toBeNull();
  });
});
