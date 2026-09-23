import type { Intent, MapRecord, Snapshot, TraverseIntent } from '@deliberate/protocol';
import { describe, expect, it } from 'vitest';

import { apply } from '../diffs/index.js';
import type { Engine } from '../engine.js';
import { hashSnapshot } from '../hash/index.js';
import {
  fixtureSnapshot,
  parseMapRows,
  FIXTURE_MAP_ID,
  FIXTURE_PLAYER_ID,
  FIXTURE_SEED,
} from '../store/index.js';
import { createEngine } from './create-engine.js';
import { exitsAt } from './traverse.js';

/**
 * `traverse` (ALE-43) — walking off one map and onto another.
 *
 * Two things are being proved here, and the second matters more than the first. One: a crossing is
 * validated like everything else, and every way of getting it wrong is refused with a sentence and
 * no mutation. Two: a crossing **moves the state hash**. An entity's map is part of the world, so
 * if the hash did not cover it a recorded session could cross maps and replay could not tell.
 */

const P = FIXTURE_PLAYER_ID;
const CELLAR = 'm0-cellar';

const CELLAR_ROWS = ['#####', '#...#', '#...#', '#####'];

const traverse = (entity: string, to: string | null = null): TraverseIntent => ({
  kind: 'traverse',
  entity,
  to,
});
const move = (entity: string, x: number, y: number): Intent => ({
  kind: 'move',
  entity,
  to: { x, y },
});

/**
 * The M0 yard with a stair down to a small cellar, and the stair back up. The player starts on
 * the yard's stair tile, so a crossing is one intent away.
 */
function twoMapSnapshot(
  over: { entrance?: { x: number; y: number }; cellar?: MapRecord } = {},
): Snapshot {
  const snapshot = fixtureSnapshot();
  const entrance = over.entrance ?? { x: 1, y: 1 };
  const yard = snapshot.world.maps[FIXTURE_MAP_ID]!;
  const stair = { x: 2, y: 2 };
  yard.exits = [{ at: stair, to: CELLAR, entrance, label: 'the cellar stair' }];
  const cellar = over.cellar ?? parseMapRows(CELLAR, CELLAR_ROWS);
  cellar.exits = [{ at: { x: 1, y: 1 }, to: FIXTURE_MAP_ID, entrance: stair, label: 'the yard' }];
  snapshot.world.maps[cellar.id] = cellar;
  // The player stands on the stair; the dummies stay in the yard.
  Object.assign(snapshot.entities[P]!.components.position!, stair);
  return snapshot;
}

const boot = (snapshot: Snapshot = twoMapSnapshot()): Engine =>
  createEngine(snapshot, { seed: FIXTURE_SEED });

function expectRejected(engine: Engine, intent: Intent, reason: RegExp): void {
  const before = engine.hash();
  const snapshot = engine.snapshot();
  const verdict = engine.apply(intent);
  expect(verdict.ok, `expected rejection, got ${JSON.stringify(verdict)}`).toBe(false);
  if (verdict.ok) return;
  expect(verdict.reason).toMatch(reason);
  expect(verdict.diff).toEqual([]);
  expect(engine.hash()).toBe(before);
  expect(engine.snapshot()).toEqual(snapshot);
}

describe('traverse', () => {
  it('walks out of one map and onto another, and back again', () => {
    const engine = boot();
    const out = engine.apply(traverse(P));
    expect(out.ok).toBe(true);
    expect(out.diff).toEqual([
      {
        type: 'EntityTraversed',
        entity: P,
        fromMap: FIXTURE_MAP_ID,
        from: { x: 2, y: 2 },
        toMap: CELLAR,
        to: { x: 1, y: 1 },
      },
    ]);
    const position = engine.snapshot().entities[P]!.components.position!;
    expect(position).toMatchObject({ map: CELLAR, x: 1, y: 1 });
    // Facing survives the door: you go through it looking the way you were walking.
    expect(position.facing).toBe(fixtureSnapshot().entities[P]!.components.position!.facing);

    const back = engine.apply(traverse(P));
    expect(back.ok).toBe(true);
    expect(engine.snapshot().entities[P]!.components.position).toMatchObject({
      map: FIXTURE_MAP_ID,
      x: 2,
      y: 2,
    });
  });

  it('puts the crossing inside the state hash, and a round trip back where it started', () => {
    const engine = boot();
    const start = engine.hash();
    expect(engine.apply(traverse(P)).ok).toBe(true);
    const away = engine.hash();
    // If the hash did not cover which map an entity is on, this would be the same world.
    expect(away).not.toBe(start);
    expect(engine.apply(traverse(P)).ok).toBe(true);
    expect(engine.hash()).toBe(start);
  });

  it('is reproduced exactly by apply(snapshot, diffs)', () => {
    const engine = boot();
    const before = engine.snapshot();
    const verdict = engine.apply(traverse(P));
    expect(verdict.ok).toBe(true);
    const folded = apply(before, verdict.diff);
    expect(hashSnapshot(folded)).toBe(engine.hash());
    // Absolute: folding it twice lands where folding it once did.
    expect(hashSnapshot(apply(folded, verdict.diff))).toBe(engine.hash());
  });

  it('refuses a crossing from anywhere but the exit tile', () => {
    const engine = boot();
    expect(engine.apply(move(P, 3, 2)).ok).toBe(true);
    expectRejected(engine, traverse(P), /no way out of m0-yard from \(3, 2\)/);
  });

  it('refuses a map the exit does not lead to, and one that has not been authored', () => {
    const engine = boot();
    expectRejected(engine, traverse(P, 'm0-attic'), /does not lead to m0-attic/);

    const orphan = twoMapSnapshot();
    delete orphan.world.maps[CELLAR];
    expectRejected(boot(orphan), traverse(P), /the cellar stair has not been mapped yet/);
  });

  it('refuses an entrance that is off the map, or a wall, or already occupied', () => {
    expectRejected(boot(twoMapSnapshot({ entrance: { x: 9, y: 9 } })), traverse(P), /off the map/);
    expectRejected(
      boot(twoMapSnapshot({ entrance: { x: 0, y: 0 } })),
      traverse(P),
      /cannot be stood on/,
    );

    const crowded = twoMapSnapshot();
    crowded.entities['dummy-a']!.components.position = { map: CELLAR, x: 1, y: 1 };
    expectRejected(boot(crowded), traverse(P), /Someone is standing where the cellar stair/);
  });

  it('refuses the dead, and anyone acting out of turn', () => {
    const dead = twoMapSnapshot();
    dead.entities[P]!.components.health = { hp: 0, maxHp: 12, conditions: ['dead'] };
    expectRejected(boot(dead), traverse(P), /dead and cannot travel/);

    const fighting = twoMapSnapshot();
    fighting.initiative = {
      order: ['dummy-a', P],
      current: 0,
      round: 1,
      turn: { movedFt: 0, actionUsed: false, bonusActionUsed: false },
    };
    expectRejected(boot(fighting), traverse(P), /turn, not Player's/);
  });

  it('costs a tile of movement in an encounter, and is refused with none left', () => {
    const fighting = twoMapSnapshot();
    fighting.initiative = {
      order: [P, 'dummy-a'],
      current: 0,
      round: 1,
      turn: { movedFt: 25, actionUsed: false, bonusActionUsed: false },
    };
    const engine = boot(fighting);
    const verdict = engine.apply(traverse(P));
    expect(verdict.ok).toBe(true);
    expect(verdict.diff.at(-1)).toEqual({
      type: 'EconomySpent',
      entity: P,
      turn: { movedFt: 30, actionUsed: false, bonusActionUsed: false },
    });
    expectRejected(engine, traverse(P), /no movement left this turn/);
  });

  it('asks which way when a tile leads more than one, and takes a named one', () => {
    const forked = twoMapSnapshot();
    const attic = parseMapRows('m0-attic', CELLAR_ROWS);
    forked.world.maps['m0-attic'] = attic;
    forked.world.maps[FIXTURE_MAP_ID]!.exits!.push({
      at: { x: 2, y: 2 },
      to: 'm0-attic',
      entrance: { x: 1, y: 1 },
      label: 'the attic ladder',
    });
    const engine = boot(forked);
    expectRejected(engine, traverse(P), /leads several ways: the cellar stair, the attic ladder/);
    expect(engine.apply(traverse(P, 'm0-attic')).ok).toBe(true);
    expect(engine.snapshot().entities[P]!.components.position!.map).toBe('m0-attic');
  });

  it('leaves a map with no exits exactly as it was', () => {
    // The M0 fixture has never had a way out and must keep behaving as though maps had none.
    const engine = createEngine(fixtureSnapshot(), { seed: FIXTURE_SEED });
    expect(exitsAt(engine.snapshot().world.maps[FIXTURE_MAP_ID]!, { x: 2, y: 2 })).toEqual([]);
    expectRejected(engine, traverse(P), /no way out of m0-yard/);
  });
});
