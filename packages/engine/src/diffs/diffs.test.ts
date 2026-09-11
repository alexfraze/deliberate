import {
  PROTOCOL_VERSION,
  type ConditionSet,
  type DamageApplied,
  type Diff,
  type Entity,
  type EntityId,
  type EntityMoved,
  type FlagSet,
  type FlagValue,
  type Health,
  type Intent,
  type Snapshot,
  type Tile,
} from '@deliberate/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { hashSnapshot } from '../hash/index.js';
import { createEngine } from '../rules/index.js';
import {
  fixtureSnapshot,
  parseMapRows,
  FIXTURE_MAP_ID,
  FIXTURE_PLAYER_ID,
} from '../store/index.js';
import { apply, applyDiff, DiffError } from './apply.js';
import {
  conditionSet,
  damageApplied,
  dialogueLine,
  entityMoved,
  entitySpawned,
  flagDiffs,
  flagSet,
  healthDiffs,
  movedDiff,
} from './emit.js';

// ---------------------------------------------------------------------------------------------
// A small generated world: a 4x4 open map, four entities, three flags. Small on purpose — the
// properties below are about the diff algebra, not about map size.
// ---------------------------------------------------------------------------------------------

const GEN_MAP = 'gen';
const GEN_SIZE = 4;
const GEN_IDS: EntityId[] = ['e0', 'e1', 'e2', 'e3'];
const SPAWN_IDS: EntityId[] = ['s0', 's1'];
const CONDITION_POOL = ['prone', 'dead', 'blessed'];
const FLAG_KEYS = ['alpha', 'beta', 'gamma'];

function genEntity(id: EntityId, i: number, tempHp: boolean): Entity {
  return {
    id,
    name: `Entity ${id}`,
    components: {
      position: { map: GEN_MAP, x: i % GEN_SIZE, y: i % 2, facing: 'N' },
      health: {
        hp: 10,
        maxHp: 10,
        ...(tempHp ? { tempHp: 3 } : {}),
        conditions: i % 2 === 0 ? [] : ['prone'],
      },
      dialogue: { seeds: ['hello'] },
    },
  };
}

function genSnapshot(tempHp = false): Snapshot {
  const map = parseMapRows(
    GEN_MAP,
    Array.from({ length: GEN_SIZE }, () => '.'.repeat(GEN_SIZE)),
  );
  const entities: Record<EntityId, Entity> = {};
  GEN_IDS.forEach((id, i) => (entities[id] = genEntity(id, i, tempHp)));
  return {
    schema: PROTOCOL_VERSION,
    entities,
    world: { flags: { alpha: true }, quests: {}, clock: 0, maps: { [map.id]: map } },
    initiative: null,
  };
}

const arbTile: fc.Arbitrary<Tile> = fc.record({
  x: fc.integer({ min: 0, max: GEN_SIZE - 1 }),
  y: fc.integer({ min: 0, max: GEN_SIZE - 1 }),
});

const arbFlagValue: fc.Arbitrary<FlagValue> = fc.oneof(
  fc.boolean(),
  fc.integer({ min: -5, max: 5 }),
  fc.string({ maxLength: 4 }),
);

/** Diffs over the generated world. Spawns use fresh ids so they never race the other diffs. */
const arbDiff: fc.Arbitrary<Diff> = fc.oneof(
  fc
    .tuple(fc.constantFrom(...GEN_IDS), arbTile, arbTile, fc.array(arbTile, { maxLength: 3 }))
    .map(([id, from, to, path]) => entityMoved(id, from, to, [...path, to])),
  fc
    .tuple(fc.constantFrom(...GEN_IDS), fc.nat(12), fc.nat(10))
    .map(([id, amount, hpAfter]) => damageApplied(id, amount, hpAfter, 'e0')),
  fc
    .tuple(fc.constantFrom(...GEN_IDS), fc.constantFrom(...CONDITION_POOL), fc.boolean())
    .map(([id, condition, active]) => conditionSet(id, condition, active)),
  fc
    .tuple(fc.constantFrom(...GEN_IDS), fc.string({ maxLength: 8 }))
    .map(([id, text]) => dialogueLine(id, text)),
  fc.tuple(fc.constantFrom(...FLAG_KEYS), arbFlagValue).map(([key, v]) => flagSet(key, v)),
  fc
    .tuple(fc.constantFrom(...SPAWN_IDS), fc.nat(3))
    .map(([id, i]) => entitySpawned(genEntity(id, i, false))),
);

const arbDiffs = fc.array(arbDiff, { maxLength: 12 });

function lastWhere<T extends Diff>(
  diffs: readonly Diff[],
  match: (d: Diff) => d is T,
): T | undefined {
  return diffs.filter(match).at(-1);
}

function health(snapshot: Snapshot, id: EntityId): Health {
  return snapshot.entities[id]!.components.health!;
}

// ---------------------------------------------------------------------------------------------

describe('apply', () => {
  it('reproduces the state the diff stream describes, by deep equality and by hash', () => {
    fc.assert(
      fc.property(arbDiffs, (diffs) => {
        const before = genSnapshot();
        const after = apply(before, diffs);

        for (const id of GEN_IDS) {
          const moved = lastWhere(
            diffs,
            (d): d is EntityMoved => d.type === 'EntityMoved' && d.entity === id,
          );
          const pos = after.entities[id]!.components.position!;
          const want = moved ? moved.to : before.entities[id]!.components.position!;
          expect({ x: pos.x, y: pos.y }).toEqual({ x: want.x, y: want.y });

          const hit = lastWhere(
            diffs,
            (d): d is DamageApplied => d.type === 'DamageApplied' && d.target === id,
          );
          expect(health(after, id).hp).toBe(hit ? hit.hpAfter : health(before, id).hp);

          const conditions = health(after, id).conditions;
          expect(new Set(conditions).size).toBe(conditions.length);
          for (const condition of CONDITION_POOL) {
            const set = lastWhere(
              diffs,
              (d): d is ConditionSet =>
                d.type === 'ConditionSet' && d.entity === id && d.condition === condition,
            );
            const want = set ? set.active : health(before, id).conditions.includes(condition);
            expect(conditions.includes(condition)).toBe(want);
          }
        }

        for (const key of FLAG_KEYS) {
          const set = lastWhere(diffs, (d): d is FlagSet => d.type === 'FlagSet' && d.key === key);
          expect(after.world.flags[key]).toStrictEqual(set ? set.value : before.world.flags[key]);
        }

        for (const id of SPAWN_IDS) {
          const spawned = diffs.some((d) => d.type === 'EntitySpawned' && d.entity.id === id);
          expect(Object.hasOwn(after.entities, id)).toBe(spawned);
        }

        // The same reduction, one diff at a time, must land on exactly the same state and hash.
        const stepwise = diffs.reduce(applyDiff, before);
        expect(stepwise).toStrictEqual(after);
        expect(hashSnapshot(stepwise)).toBe(hashSnapshot(after));
      }),
      { seed: 1010, numRuns: 300 },
    );
  });

  it('never mutates its input', () => {
    fc.assert(
      fc.property(arbDiffs, (diffs) => {
        const before = genSnapshot(true);
        const frozen = structuredClone(before);
        const hash = hashSnapshot(before);
        apply(before, diffs);
        expect(before).toStrictEqual(frozen);
        expect(hashSnapshot(before)).toBe(hash);
      }),
      { seed: 2020, numRuns: 200 },
    );
  });

  it('is idempotent: every diff states an absolute value', () => {
    fc.assert(
      fc.property(arbDiffs, (diffs) => {
        const once = apply(genSnapshot(), diffs);
        expect(apply(once, diffs)).toStrictEqual(once);
      }),
      { seed: 3030, numRuns: 200 },
    );
  });

  it('splits anywhere: apply(s, a ++ b) == apply(apply(s, a), b)', () => {
    fc.assert(
      fc.property(arbDiffs, arbDiffs, (a, b) => {
        const s = genSnapshot();
        expect(apply(s, [...a, ...b])).toStrictEqual(apply(apply(s, a), b));
      }),
      { seed: 4040, numRuns: 200 },
    );
  });

  it('leaves the state hash alone for DialogueLine, which is narration only', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 8 }), { maxLength: 5 }), (texts) => {
        const s = genSnapshot();
        const lines = texts.map((t) => dialogueLine('e0', t, 'e1'));
        expect(apply(s, lines)).toStrictEqual(s);
        expect(hashSnapshot(apply(s, lines))).toBe(hashSnapshot(s));
      }),
      { seed: 5050 },
    );
  });

  it('takes facing from the last step of the path', () => {
    const s = genSnapshot();
    const moved = apply(s, [
      entityMoved('e0', { x: 0, y: 0 }, { x: 2, y: 2 }, [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ]),
    ]);
    expect(moved.entities['e0']!.components.position!.facing).toBe('SE');
    // A path that only names the destination keeps the previous facing when it cannot be derived.
    const stay = apply(s, [entityMoved('e0', { x: 0, y: 0 }, { x: 0, y: 0 }, [{ x: 0, y: 0 }])]);
    expect(stay.entities['e0']!.components.position!.facing).toBe('N');
  });

  it('drains temporary hit points before real ones', () => {
    const s = genSnapshot(true);
    const after = apply(s, [damageApplied('e0', 2, 10)]);
    expect(health(after, 'e0')).toEqual({ hp: 10, maxHp: 10, tempHp: 1, conditions: [] });
    const through = apply(s, [damageApplied('e0', 5, 8)]);
    expect(health(through, 'e0')).toEqual({ hp: 8, maxHp: 10, tempHp: 0, conditions: [] });
  });

  it('replaces an entity when a spawn reuses its id', () => {
    const s = genSnapshot();
    const replacement: Entity = { id: 'e0', name: 'Impostor', components: {} };
    expect(apply(s, [entitySpawned(replacement)]).entities['e0']).toStrictEqual(replacement);
  });

  it('rejects diffs that name something the snapshot does not have', () => {
    const s = genSnapshot();
    expect(() => apply(s, [damageApplied('nobody', 1, 0)])).toThrow(DiffError);
    expect(() => apply(s, [entityMoved('nobody', { x: 0, y: 0 }, { x: 1, y: 1 }, [])])).toThrow(
      DiffError,
    );
    const noHealth = apply(s, [entitySpawned({ id: 'bare', name: 'Bare', components: {} })]);
    expect(() => apply(noHealth, [conditionSet('bare', 'prone', true)])).toThrow(DiffError);
  });
});

// ---------------------------------------------------------------------------------------------
// End to end against the real engine (ALE-8/ALE-9): the diffs the engine emits, folded over the
// snapshot it emitted them from, must reproduce the engine's own state hash.
// ---------------------------------------------------------------------------------------------

describe('apply against createEngine', () => {
  it('reproduces the engine state after a run of move intents', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.array(
          fc.record({
            x: fc.integer({ min: 0, max: 11 }),
            y: fc.integer({ min: 0, max: 11 }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (seed, tiles) => {
          const initial = fixtureSnapshot();
          const engine = createEngine(initial, { seed });
          const diffs: Diff[] = [];
          let accepted = 0;
          for (const to of tiles) {
            const intent: Intent = { kind: 'move', entity: FIXTURE_PLAYER_ID, to };
            const verdict = engine.apply(intent);
            if (verdict.ok) accepted += 1;
            diffs.push(...verdict.diff);
          }
          const folded = apply(initial, diffs);
          expect(folded).toStrictEqual(engine.snapshot());
          expect(hashSnapshot(folded)).toBe(engine.hash());
          // A rejected intent emits nothing, so the fold is also unchanged by it.
          expect(diffs.length).toBe(accepted);
        },
      ),
      { seed: 6060, numRuns: 150 },
    );
  });

  it('reproduces the damage and death an attack emits', () => {
    const initial = fixtureSnapshot();
    const engine = createEngine(initial, { seed: 'attack-roundtrip' });
    const diffs: Diff[] = [];
    // Walk into reach of dummy A at (8, 3), then swing until it drops.
    for (const to of [
      { x: 5, y: 2 },
      { x: 7, y: 3 },
    ]) {
      const verdict = engine.apply({ kind: 'move', entity: FIXTURE_PLAYER_ID, to });
      expect(verdict.ok).toBe(true);
      diffs.push(...verdict.diff);
    }
    let swings = 0;
    while (swings < 40) {
      swings += 1;
      const verdict = engine.apply({
        kind: 'attack',
        attacker: FIXTURE_PLAYER_ID,
        target: 'dummy-a',
        ability: 'longsword',
      });
      if (!verdict.ok) {
        // Out of action economy for this turn; end it and carry on.
        const end = engine.apply({ kind: 'end_turn', entity: FIXTURE_PLAYER_ID });
        if (!end.ok) break;
        diffs.push(...end.diff);
        continue;
      }
      diffs.push(...verdict.diff);
      if (verdict.diff.some((d) => d.type === 'ConditionSet' && d.condition === 'dead')) break;
    }
    const folded = apply(initial, diffs);
    expect(folded.entities['dummy-a']!.components.health).toStrictEqual(
      engine.snapshot().entities['dummy-a']!.components.health,
    );
    expect(diffs.some((d) => d.type === 'DamageApplied')).toBe(true);
  });
});

describe('emit', () => {
  it('builds a move from before and after positions, and nothing for a turn in place', () => {
    const before = { map: FIXTURE_MAP_ID, x: 1, y: 1, facing: 'N' as const };
    expect(movedDiff('e0', before, { ...before, x: 2 })).toEqual({
      type: 'EntityMoved',
      entity: 'e0',
      from: { x: 1, y: 1 },
      to: { x: 2, y: 1 },
      path: [{ x: 2, y: 1 }],
    });
    expect(movedDiff('e0', before, { ...before, facing: 'S' })).toBeNull();
  });

  it('derives damage and condition diffs from a health change', () => {
    const before: Health = { hp: 6, maxHp: 10, tempHp: 2, conditions: ['prone'] };
    const after: Health = { hp: 0, maxHp: 10, tempHp: 0, conditions: ['dead'] };
    expect(healthDiffs('e1', before, after, 'e0')).toEqual([
      { type: 'DamageApplied', target: 'e1', amount: 8, source: 'e0', hpAfter: 0 },
      { type: 'ConditionSet', entity: 'e1', condition: 'dead', active: true },
      { type: 'ConditionSet', entity: 'e1', condition: 'prone', active: false },
    ]);
    expect(healthDiffs('e1', before, before)).toEqual([]);
  });

  it('round-trips a health change through apply', () => {
    fc.assert(
      fc.property(fc.nat(10), fc.boolean(), (hp, prone) => {
        const s = genSnapshot(true);
        const before = health(s, 'e0');
        const after: Health = { ...before, hp, conditions: prone ? ['prone'] : [] };
        const folded = apply(s, healthDiffs('e0', before, after));
        expect(health(folded, 'e0').hp).toBe(after.hp);
        expect(health(folded, 'e0').conditions).toEqual(after.conditions);
      }),
      { seed: 7070 },
    );
  });

  it('reports only the world flags that changed, in key order', () => {
    expect(flagDiffs({ a: 1, b: true }, { a: 1, b: false, c: 'x' })).toEqual([
      { type: 'FlagSet', key: 'b', value: false },
      { type: 'FlagSet', key: 'c', value: 'x' },
    ]);
  });

  it('copies the entity it spawns so later mutation cannot leak in', () => {
    const entity = genEntity('s0', 0, false);
    const diff = entitySpawned(entity);
    entity.name = 'changed';
    expect(diff.entity.name).toBe('Entity s0');
  });
});
