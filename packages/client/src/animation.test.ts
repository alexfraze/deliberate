import type { ConditionSet, DamageApplied, Diff, EntityMoved } from '@deliberate/protocol';
import { describe, expect, it } from 'vitest';

import {
  AnimationQueue,
  DAMAGE_MS,
  DEATH_MS,
  LUNGE_MS,
  MS_PER_TILE,
  animationFor,
  collapseAmount,
  samplePath,
  strikePhase,
  type DamageAnimation,
  type QueueEvent,
} from './animation.js';

const moved: EntityMoved = {
  type: 'EntityMoved',
  entity: 'player',
  from: { x: 1, y: 1 },
  to: { x: 3, y: 1 },
  path: [
    { x: 2, y: 1 },
    { x: 3, y: 1 },
  ],
};

const damaged: DamageApplied = {
  type: 'DamageApplied',
  target: 'dummy-a',
  amount: 5,
  source: 'player',
  hpAfter: 5,
};

const flagged: Diff = { type: 'FlagSet', key: 'tutorial', value: false };

const died: ConditionSet = {
  type: 'ConditionSet',
  entity: 'dummy-a',
  condition: 'dead',
  active: true,
};

function kinds(events: QueueEvent[]): string[] {
  return events.map((e) => `${e.type}:${e.animation.diff.type}`);
}

describe('animationFor', () => {
  it('prepends `from` so the tween starts where the entity stands', () => {
    const animation = animationFor(moved);
    expect(animation.kind).toBe('move');
    if (animation.kind !== 'move') throw new Error('unreachable');
    expect(animation.waypoints).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ]);
    expect(animation.durationMs).toBe(2 * MS_PER_TILE);
  });

  it('does not double the first waypoint when the path already includes it', () => {
    const animation = animationFor({
      ...moved,
      path: [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
      ],
    });
    if (animation.kind !== 'move') throw new Error('unreachable');
    expect(animation.waypoints).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ]);
  });

  it('survives an empty path by falling back to the destination', () => {
    const animation = animationFor({ ...moved, path: [] });
    if (animation.kind !== 'move') throw new Error('unreachable');
    expect(animation.waypoints).toEqual([
      { x: 1, y: 1 },
      { x: 3, y: 1 },
    ]);
    expect(animation.durationMs).toBeGreaterThan(0);
  });

  it('gives damage a flash and everything else an instant beat', () => {
    expect(animationFor(damaged).durationMs).toBe(LUNGE_MS + DAMAGE_MS);
    expect(animationFor(flagged).kind).toBe('instant');
    expect(animationFor(flagged).durationMs).toBe(0);
  });

  it('prepends a lunge only when somebody else struck the blow', () => {
    const struck = animationFor(damaged) as DamageAnimation;
    expect(struck.attacker).toBe('player');
    expect(struck.lungeMs).toBe(LUNGE_MS);

    // Poison, a fall, a trap: nothing swung, so the blow lands immediately.
    const sourceless = animationFor({ ...damaged, source: null }) as DamageAnimation;
    expect(sourceless.attacker).toBeNull();
    expect(sourceless.durationMs).toBe(DAMAGE_MS);

    // Self-inflicted: an entity cannot lunge at itself without leaving its own tile.
    const selfHarm = animationFor({ ...damaged, source: damaged.target }) as DamageAnimation;
    expect(selfHarm.attacker).toBeNull();
  });

  it('animates going down, and only when the condition turns on', () => {
    expect(animationFor(died).kind).toBe('death');
    expect(animationFor(died).durationMs).toBe(DEATH_MS);
    // Coming back up is not a death animation, and neither is any other condition.
    expect(animationFor({ ...died, active: false }).kind).toBe('instant');
    expect(animationFor({ ...died, condition: 'prone' }).kind).toBe('instant');
  });
});

describe('strikePhase', () => {
  const struck = animationFor(damaged) as DamageAnimation;

  it('does not flash the target until the attacker has finished swinging', () => {
    const boundary = struck.lungeMs / struck.durationMs;
    expect(strikePhase(struck, 0)).toEqual({ lunge: 0, hit: 0 });
    expect(strikePhase(struck, boundary / 2).hit).toBe(0);
    expect(strikePhase(struck, boundary / 2).lunge).toBeCloseTo(0.5, 5);
    // Fully extended exactly as the blow lands, and the flash starts from there.
    expect(strikePhase(struck, boundary).lunge).toBe(1);
    expect(strikePhase(struck, boundary).hit).toBe(0);
    expect(strikePhase(struck, boundary + (1 - boundary) / 2).hit).toBeCloseTo(1, 5);
  });

  it('brings the attacker home and the flash back to nothing by the end', () => {
    const end = strikePhase(struck, 1);
    expect(end.lunge).toBe(0);
    expect(end.hit).toBeCloseTo(0, 5);
    // Out-of-range time is clamped rather than extrapolated into a capsule flying off the map.
    expect(strikePhase(struck, 4)).toEqual(strikePhase(struck, 1));
    expect(strikePhase(struck, -4)).toEqual(strikePhase(struck, 0));
  });

  it('skips the swing entirely when nothing swung', () => {
    const sourceless = animationFor({ ...damaged, source: null }) as DamageAnimation;
    expect(sourceless.lungeMs).toBe(0);
    expect(strikePhase(sourceless, 0.5)).toEqual({ lunge: 0, hit: 1 });
    expect(strikePhase(sourceless, 0).hit).toBe(0);
  });
});

describe('collapseAmount', () => {
  it('folds a capsule flat by the end, easing out, and clamps', () => {
    expect(collapseAmount(0)).toBe(0);
    expect(collapseAmount(1)).toBe(1);
    expect(collapseAmount(0.5)).toBeGreaterThan(0.5); // eased, so it settles rather than snaps
    expect(collapseAmount(-1)).toBe(0);
    expect(collapseAmount(9)).toBe(1);
  });
});

describe('samplePath', () => {
  it('walks the waypoints at constant speed', () => {
    const path = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
    ];
    expect(samplePath(path, 0)).toEqual({ x: 0, y: 0 });
    expect(samplePath(path, 0.25)).toEqual({ x: 1, y: 0 });
    expect(samplePath(path, 0.5)).toEqual({ x: 2, y: 0 });
    expect(samplePath(path, 0.75)).toEqual({ x: 2, y: 1 });
    expect(samplePath(path, 1)).toEqual({ x: 2, y: 2 });
  });

  it('clamps out-of-range time and degenerate paths', () => {
    expect(samplePath([{ x: 4, y: 4 }], 0.5)).toEqual({ x: 4, y: 4 });
    expect(samplePath([], 0.5)).toEqual({ x: 0, y: 0 });
    const path = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
    expect(samplePath(path, -3)).toEqual({ x: 0, y: 0 });
    expect(samplePath(path, 3)).toEqual({ x: 1, y: 0 });
  });
});

describe('AnimationQueue ordering', () => {
  it('plays one diff at a time, in the order the server sent them', () => {
    const queue = new AnimationQueue();
    queue.enqueue([moved, damaged]);
    expect(queue.pending).toBe(2);

    const first = queue.advance(MS_PER_TILE);
    expect(kinds(first)).toEqual(['start:EntityMoved', 'progress:EntityMoved']);
    expect(first.at(-1)).toMatchObject({ t: 0.5 });
    // The damage animation has not been touched while the move is still running.
    expect(queue.current?.diff.type).toBe('EntityMoved');

    const second = queue.advance(MS_PER_TILE);
    expect(kinds(second)).toEqual([
      'progress:EntityMoved',
      'finish:EntityMoved',
      'start:DamageApplied',
      'progress:DamageApplied',
    ]);
    expect(queue.current?.diff.type).toBe('DamageApplied');

    const third = queue.advance(LUNGE_MS + DAMAGE_MS);
    expect(kinds(third)).toEqual(['progress:DamageApplied', 'finish:DamageApplied']);
    expect(queue.idle).toBe(true);
    expect(queue.advance(1000)).toEqual([]);
  });

  it('emits exactly one start and one finish per diff, with t reaching 1', () => {
    const queue = new AnimationQueue();
    queue.enqueue([moved, damaged, flagged]);
    const events: QueueEvent[] = [];
    for (let i = 0; i < 200 && !queue.idle; i += 1) events.push(...queue.advance(16));
    expect(queue.idle).toBe(true);
    for (const diff of [moved, damaged, flagged]) {
      expect(events.filter((e) => e.type === 'start' && e.animation.diff === diff)).toHaveLength(1);
      expect(events.filter((e) => e.type === 'finish' && e.animation.diff === diff)).toHaveLength(
        1,
      );
    }
    const finalMove = events.findIndex((e) => e.type === 'finish' && e.animation.diff === moved);
    const startDamage = events.findIndex((e) => e.type === 'start' && e.animation.diff === damaged);
    expect(finalMove).toBeLessThan(startDamage);
    for (const diff of [moved, damaged]) {
      const last = events.filter((e) => e.type === 'progress' && e.animation.diff === diff).at(-1);
      expect(last).toMatchObject({ t: 1 });
    }
  });

  it('spills leftover time into the next diff rather than dropping it', () => {
    const queue = new AnimationQueue();
    queue.enqueue([moved, damaged]);
    const events = queue.advance(2 * MS_PER_TILE + LUNGE_MS + DAMAGE_MS);
    expect(kinds(events)).toEqual([
      'start:EntityMoved',
      'progress:EntityMoved',
      'finish:EntityMoved',
      'start:DamageApplied',
      'progress:DamageApplied',
      'finish:DamageApplied',
    ]);
    expect(queue.idle).toBe(true);
  });

  it('drains zero-duration diffs without blocking', () => {
    const queue = new AnimationQueue();
    queue.enqueue([flagged, flagged, damaged]);
    const events = queue.advance(0);
    expect(kinds(events)).toEqual([
      'start:FlagSet',
      'progress:FlagSet',
      'finish:FlagSet',
      'start:FlagSet',
      'progress:FlagSet',
      'finish:FlagSet',
      'start:DamageApplied',
      'progress:DamageApplied',
    ]);
  });

  it('keeps queued messages in arrival order across enqueues, and clears', () => {
    const queue = new AnimationQueue();
    queue.enqueue([damaged]);
    queue.enqueue([moved]);
    const events = queue.advance(10_000);
    expect(kinds(events).filter((k) => k.startsWith('start'))).toEqual([
      'start:DamageApplied',
      'start:EntityMoved',
    ]);
    queue.enqueue([moved, damaged]);
    queue.advance(1);
    queue.clear();
    expect(queue.idle).toBe(true);
    expect(queue.current).toBeNull();
  });
});
