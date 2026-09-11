import type { Intent, Snapshot } from '@deliberate/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Engine } from '../engine.js';
import { hashSnapshot } from '../hash/index.js';
import { fixtureSnapshot, FIXTURE_PLAYER_ID, FIXTURE_SEED } from '../store/index.js';
import { createEngine } from './create-engine.js';

const P = FIXTURE_PLAYER_ID;
const A = 'dummy-a';
const B = 'dummy-b';

const boot = (snapshot: Snapshot = fixtureSnapshot(), seed = FIXTURE_SEED) =>
  createEngine(snapshot, { seed });

const move = (entity: string, x: number, y: number): Intent => ({
  kind: 'move',
  entity,
  to: { x, y },
});
const attack = (attacker: string, target: string, ability = 'longsword'): Intent => ({
  kind: 'attack',
  attacker,
  target,
  ability,
});
const endTurn = (entity: string): Intent => ({ kind: 'end_turn', entity });

/** Fixture with the player standing next to dummy A at (8,3). */
function adjacentSnapshot(): Snapshot {
  const s = fixtureSnapshot();
  s.entities[P]!.components.position!.x = 7;
  s.entities[P]!.components.position!.y = 3;
  return s;
}

function expectRejected(engine: Engine, intent: Intent, reason: RegExp) {
  const before = engine.hash();
  const snapBefore = engine.snapshot();
  const verdict = engine.apply(intent);
  expect(verdict.ok, `expected rejection, got ${JSON.stringify(verdict)}`).toBe(false);
  if (verdict.ok) return;
  expect(verdict.reason).toMatch(reason);
  expect(verdict.diff).toEqual([]);
  expect(engine.hash()).toBe(before);
  expect(engine.snapshot()).toEqual(snapBefore);
}

/** Open an encounter: the player attacks A from the adjacent square. Returns the engine. */
function inCombat(seed = FIXTURE_SEED): Engine {
  const engine = boot(adjacentSnapshot(), seed);
  const v = engine.apply(attack(P, A));
  expect(v.ok).toBe(true);
  return engine;
}

describe('createEngine: snapshot and hash', () => {
  it('reports the snapshot and its hash without aliasing and without mutating at construction', () => {
    const initial = fixtureSnapshot();
    const engine = boot(initial);
    expect(engine.snapshot()).toEqual(initial);
    expect(engine.hash()).toBe(hashSnapshot(initial));
    const snap = engine.snapshot();
    snap.world.clock = 5;
    expect(engine.snapshot().world.clock).toBe(0);
  });
});

describe('createEngine: exploration (no encounter)', () => {
  it('moves a living entity along a path within its speed and emits EntityMoved', () => {
    const engine = boot();
    const before = engine.hash();
    const verdict = engine.apply(move(P, 6, 4));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.diff).toHaveLength(1);
    const d = verdict.diff[0]!;
    expect(d.type).toBe('EntityMoved');
    if (d.type !== 'EntityMoved') return;
    expect(d.from).toEqual({ x: 2, y: 2 });
    expect(d.to).toEqual({ x: 6, y: 4 });
    expect(d.path.at(-1)).toEqual({ x: 6, y: 4 });
    expect(d.path.length).toBeLessThanOrEqual(6);
    expect(engine.snapshot().entities[P]!.components.position).toMatchObject({ x: 6, y: 4 });
    expect(engine.hash()).not.toBe(before);
    // Out of an encounter the whole speed is available again on the next intent.
    expect(engine.apply(move(P, 2, 2)).ok).toBe(true);
  });

  it.each<[string, Intent, RegExp]>([
    ['unknown entity', move('nobody', 1, 1), /no one called/],
    ['off map', move(P, 40, 1), /off the map/],
    ['wall', move(P, 0, 0), /cannot be walked/],
    ['occupied', move(P, 8, 3), /occupied/],
    ['same tile', move(P, 2, 2), /already there/],
    ['too far', move(P, 10, 10), /can move 30 ft/],
    ['attack out of reach', attack(P, A), /is 30 ft away; a longsword reaches 5 ft/],
    ['attack unknown weapon', attack(P, A, 'laser'), /does not know how to attack with laser/],
    ['attack weapon not held', attack(P, A, 'shortbow'), /does not have a shortbow/],
    ['attack self', attack(P, P), /cannot attack themself/],
    ['attack missing target', attack(P, 'ghost'), /no one called ghost/],
    ['end turn outside encounter', endTurn(P), /No encounter is running/],
    ['end turn unknown entity', endTurn('ghost'), /no one called/],
  ])('rejects %s with a readable reason and changes nothing', (_label, intent, reason) => {
    expectRejected(boot(), intent, reason);
  });

  it('rejects actions by dead, unconscious, or unplaced entities', () => {
    const dead = fixtureSnapshot();
    dead.entities[P]!.components.health!.hp = 0;
    expectRejected(boot(dead), move(P, 3, 2), /dead and cannot move/);
    expectRejected(boot(dead), attack(P, A), /dead and cannot attack/);

    const out = fixtureSnapshot();
    out.entities[P]!.components.health!.conditions = ['unconscious'];
    expectRejected(boot(out), move(P, 3, 2), /unconscious and cannot move/);

    const nowhere = fixtureSnapshot();
    delete nowhere.entities[P]!.components.position;
    expectRejected(boot(nowhere), move(P, 3, 2), /not on the map/);

    const deadTarget = adjacentSnapshot();
    deadTarget.entities[A]!.components.health!.hp = 0;
    expectRejected(boot(deadTarget), attack(P, A), /already dead/);
  });

  it('requires line of sight for ranged attacks and reports the blocker', () => {
    // Player at (4,5) with a shortbow; dummy B at (6,9) is behind the middle wall (row 6).
    const s = fixtureSnapshot();
    s.entities[P]!.components.position!.x = 4;
    s.entities[P]!.components.position!.y = 5;
    s.entities[P]!.components.inventory!.items.push({ item: 'shortbow', qty: 1 });
    expectRejected(boot(s), attack(P, B, 'shortbow'), /cannot see Training Dummy B/);
    // Through the gap at (5,6): player at (5,5) sees (5,7).
    s.entities[P]!.components.position!.x = 5;
    s.entities[B]!.components.position!.x = 5;
    s.entities[B]!.components.position!.y = 7;
    expect(boot(s).apply(attack(P, B, 'shortbow')).ok).toBe(true);
  });
});

describe('createEngine: encounters', () => {
  it('the first attack rolls initiative, lets the attacker act first, and spends the action', () => {
    const engine = inCombat();
    const init = engine.snapshot().initiative!;
    expect([...init.order].sort()).toEqual([A, B, P].sort());
    expect(init.order[init.current]).toBe(P);
    expect(init.round).toBe(1);
    expect(init.turn).toEqual({ movedFt: 0, actionUsed: true, bonusActionUsed: false });
  });

  it('a hit emits DamageApplied with hpAfter; a kill adds ConditionSet dead and blocks further attacks', () => {
    // Pick a seed whose opening swing hits, so the test does not depend on luck.
    let engine: Engine | undefined;
    let verdict: ReturnType<Engine['apply']> | undefined;
    for (let i = 0; i < 50 && !engine; i++) {
      const e = boot(adjacentSnapshot(), `hit-${i}`);
      const v = e.apply(attack(P, A));
      if (v.ok && v.diff.length > 0) {
        engine = e;
        verdict = v;
      }
    }
    expect(engine).toBeDefined();
    let killed = false;
    const inspect = (v: ReturnType<Engine['apply']>) => {
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      for (const d of v.diff) {
        if (d.type === 'DamageApplied') {
          expect(d.target).toBe(A);
          expect(d.source).toBe(P);
          expect(d.amount).toBeGreaterThan(0);
          expect(d.hpAfter).toBe(engine!.snapshot().entities[A]!.components.health!.hp);
        }
        if (d.type === 'ConditionSet') {
          expect(d).toEqual({ type: 'ConditionSet', entity: A, condition: 'dead', active: true });
          killed = true;
        }
      }
    };
    inspect(verdict!);
    expect(engine!.snapshot().entities[A]!.components.health!.hp).toBeLessThan(10);
    // Keep swinging across turns until A dies (dummies never act, so this always terminates).
    for (let round = 0; round < 60 && !killed; round++) {
      expect(engine!.apply(endTurn(P)).ok).toBe(true);
      inspect(engine!.apply(attack(P, A)));
    }
    expect(killed).toBe(true);
    const health = engine!.snapshot().entities[A]!.components.health!;
    expect(health.hp).toBe(0);
    expect(health.conditions).toContain('dead');
    // The kill emitted exactly one ConditionSet; a later hit on a corpse is impossible.
    expect(engine!.apply(endTurn(P)).ok).toBe(true);
    expectRejected(engine!, attack(P, A), /already dead/);
    // Dead entities are skipped in the order but the body still occupies its tile.
    const init = engine!.snapshot().initiative!;
    expect(init.order[init.current]).toBe(P);
    expectRejected(engine!, move(P, 8, 3), /occupied/);
  });

  it('enforces whose turn it is, and one action, one bonus action, one move per turn', () => {
    const engine = inCombat();
    expectRejected(engine, move(A, 8, 2), /It is Player's turn, not Training Dummy A's/);
    expectRejected(engine, attack(A, P, 'unarmed'), /It is Player's turn/);
    expectRejected(engine, endTurn(A), /It is Player's turn/);

    // Action spent: a second longsword swing is refused; only a light weapon may follow.
    expectRejected(
      engine,
      attack(P, A),
      /already used their action this turn; only a light weapon/,
    );
    // Give the player a dagger for an off-hand attack.
    const s = adjacentSnapshot();
    s.entities[P]!.components.inventory!.items.push({ item: 'dagger', qty: 1 });
    const e2 = boot(s);
    expect(e2.apply(attack(P, A)).ok).toBe(true);
    expect(e2.apply(attack(P, A, 'dagger')).ok).toBe(true);
    expect(e2.snapshot().initiative!.turn).toMatchObject({
      actionUsed: true,
      bonusActionUsed: true,
    });
    expectRejected(e2, attack(P, A, 'dagger'), /already used their action and bonus action/);

    // Movement is a budget of 30 ft spent in pieces.
    expect(engine.apply(move(P, 5, 3)).ok).toBe(true); // 2 tiles = 10 ft
    expect(engine.snapshot().initiative!.turn!.movedFt).toBe(10);
    expectRejected(engine, move(P, 5, 9), /ft away; Player has 20 ft of movement left/);
    expect(engine.apply(move(P, 1, 3)).ok).toBe(true); // 4 tiles = 20 ft
    expect(engine.snapshot().initiative!.turn!.movedFt).toBe(30);
    expectRejected(engine, move(P, 2, 3), /no movement left this turn/);

    // End turn resets the economy for the next player turn (dummies are skipped, round advances).
    // The advance is itself a diff (ALE-13), so a diff-driven client can see whose turn it is.
    const ended = engine.apply(endTurn(P));
    expect(ended.ok).toBe(true);
    expect(ended.diff).toEqual([
      {
        type: 'TurnAdvanced',
        initiative: engine.snapshot().initiative,
        clock: engine.snapshot().world.clock,
      },
    ]);
    const init = engine.snapshot().initiative!;
    expect(init.round).toBe(2);
    expect(init.order[init.current]).toBe(P);
    expect(init.turn).toEqual({ movedFt: 0, actionUsed: false, bonusActionUsed: false });
    expect(engine.snapshot().world.clock).toBe(1);
    expect(engine.apply(move(P, 2, 3)).ok).toBe(true);
  });

  it('ends the encounter when nobody who can act on their own is left', () => {
    // A GM-driven dummy (brain 'none') is current; the player and the other dummy are dead.
    const s = adjacentSnapshot();
    s.entities[P]!.components.health!.hp = 0;
    s.entities[P]!.components.health!.conditions = ['dead'];
    s.entities[A]!.components.health!.hp = 0;
    s.entities[A]!.components.health!.conditions = ['dead'];
    s.initiative = { order: [P, A, B], current: 2, round: 3 };
    const engine = boot(s);
    expectRejected(engine, endTurn(P), /dead and cannot end their turn/);
    const v = engine.apply(endTurn(B));
    expect(v).toEqual({
      ok: true,
      diff: [{ type: 'TurnAdvanced', initiative: null, clock: 1 }],
    });
    expect(engine.snapshot().initiative).toBeNull();
    expect(engine.snapshot().world.clock).toBe(1);
    // Back in exploration: the survivor moves freely.
    expect(engine.apply(move(B, 6, 8)).ok).toBe(true);
  });

  it('resolves a full round deterministically from a seed', () => {
    const script: Intent[] = [
      attack(P, A),
      move(P, 6, 4),
      endTurn(P),
      move(P, 7, 3),
      attack(P, A),
      endTurn(P),
      attack(P, A, 'unarmed'),
      endTurn(P),
    ];
    const run = (seed: string) => {
      const engine = boot(adjacentSnapshot(), seed);
      const out = script.map((i) => {
        const v = engine.apply(i);
        return { ok: v.ok, diff: v.diff, hash: engine.hash() };
      });
      return { out, final: engine.snapshot() };
    };
    const a = run('round-seed');
    const b = run('round-seed');
    expect(a).toEqual(b);
    expect(a.final.initiative!.round).toBe(4);
    expect(a.final.world.clock).toBe(3);
    // Different seeds diverge somewhere in the initiative order or the rolls.
    const seeds = ['s1', 's2', 's3', 's4', 's5', 's6'];
    const hashes = new Set(seeds.map((s) => run(s).out.at(-1)!.hash));
    expect(hashes.size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Property tests (seeded): the ALE-9 exit criteria
// ---------------------------------------------------------------------------------------------

const entityArb = fc.constantFrom(P, A, B, 'ghost');
const tileArb = fc.record({
  x: fc.integer({ min: -1, max: 12 }),
  y: fc.integer({ min: -1, max: 12 }),
});
const weaponArb = fc.constantFrom('longsword', 'unarmed', 'dagger', 'shortbow', 'laser');
const intentArb: fc.Arbitrary<Intent> = fc.oneof(
  fc.record({ kind: fc.constant('move' as const), entity: entityArb, to: tileArb }),
  fc.record({
    kind: fc.constant('attack' as const),
    attacker: entityArb,
    target: entityArb,
    ability: weaponArb,
  }),
  fc.record({ kind: fc.constant('end_turn' as const), entity: entityArb }),
);

/** Random but legal-leaning starting positions so encounters actually happen. */
const startArb = fc.record({
  seed: fc.string({ minLength: 1, maxLength: 8 }),
  adjacent: fc.boolean(),
  intents: fc.array(intentArb, { maxLength: 40 }),
});

describe('properties', () => {
  it('no illegal intent ever changes the state hash; every legal one does', () => {
    fc.assert(
      fc.property(startArb, ({ seed, adjacent, intents }) => {
        const engine = boot(adjacent ? adjacentSnapshot() : fixtureSnapshot(), seed);
        for (const intent of intents) {
          const before = engine.hash();
          const snapBefore = engine.snapshot();
          const verdict = engine.apply(intent);
          if (verdict.ok) {
            expect(engine.hash()).not.toBe(before);
          } else {
            expect(verdict.reason.length).toBeGreaterThan(0);
            expect(verdict.diff).toEqual([]);
            expect(engine.hash()).toBe(before);
            expect(engine.snapshot()).toEqual(snapBefore);
          }
        }
      }),
      { seed: 9, numRuns: 200 },
    );
  });

  it('invariants hold after any intent sequence: no shared tiles, hp in [0,maxHp], dead iff hp 0, current is alive', () => {
    fc.assert(
      fc.property(startArb, ({ seed, adjacent, intents }) => {
        const engine = boot(adjacent ? adjacentSnapshot() : fixtureSnapshot(), seed);
        for (const intent of intents) engine.apply(intent);
        const snap = engine.snapshot();
        const tiles = new Set<string>();
        for (const e of Object.values(snap.entities)) {
          const p = e.components.position!;
          const k = `${p.x},${p.y}`;
          expect(tiles.has(k)).toBe(false);
          tiles.add(k);
          const h = e.components.health!;
          expect(h.hp).toBeGreaterThanOrEqual(0);
          expect(h.hp).toBeLessThanOrEqual(h.maxHp);
          expect(h.conditions.includes('dead')).toBe(h.hp === 0);
        }
        if (snap.initiative) {
          const cur = snap.initiative.order[snap.initiative.current]!;
          expect(snap.entities[cur]!.components.health!.hp).toBeGreaterThan(0);
          expect(snap.initiative.round).toBeGreaterThanOrEqual(1);
          expect(snap.initiative.turn!.movedFt).toBeLessThanOrEqual(
            snap.entities[cur]!.components.stats!.speed,
          );
        }
      }),
      { seed: 9, numRuns: 200 },
    );
  });

  it('replays deterministically: same seed and intents give identical hash sequences', () => {
    fc.assert(
      fc.property(startArb, ({ seed, adjacent, intents }) => {
        const run = () => {
          const engine = boot(adjacent ? adjacentSnapshot() : fixtureSnapshot(), seed);
          return intents.map((i) => {
            const v = engine.apply(i);
            return [v.ok, v.ok ? v.diff : v.reason, engine.hash()];
          });
        };
        expect(run()).toEqual(run());
      }),
      { seed: 9, numRuns: 100 },
    );
  });

  it('a full round of initiative resolves deterministically from a seed for any starting layout', () => {
    // Random walkable, distinct positions for the three fixture entities; player attacks whoever is
    // adjacent (or unarmed-punches the air is illegal, so we move first), then ends turns until a
    // round completes. Two engines with the same seed agree on everything.
    const posArb = fc.uniqueArray(
      fc.record({ x: fc.integer({ min: 1, max: 10 }), y: fc.integer({ min: 1, max: 5 }) }),
      { minLength: 3, maxLength: 3, comparator: (a, b) => a.x === b.x && a.y === b.y },
    );
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), posArb, (seed, positions) => {
        const s = fixtureSnapshot();
        const ids = [P, A, B];
        const map = s.world.maps['m0-yard']!;
        for (let i = 0; i < 3; i++) {
          const { x, y } = positions[i]!;
          if (!map.cells[y * map.width + x]!.walkable) return; // skip layouts on walls
          s.entities[ids[i]!]!.components.position!.x = x;
          s.entities[ids[i]!]!.components.position!.y = y;
        }
        // A dagger (range 60 ft) so the player can open the encounter from anywhere in the region.
        s.entities[P]!.components.inventory!.items.push({ item: 'dagger', qty: 1 });
        const run = () => {
          const engine = boot(s, seed);
          const log: unknown[] = [];
          const started = engine.apply(attack(P, A, 'dagger'));
          log.push(started, engine.hash());
          if (!started.ok) return log;
          const startRound = engine.snapshot().initiative!.round;
          for (let i = 0; i < 10; i++) {
            const init = engine.snapshot().initiative;
            if (!init || init.round > startRound) break;
            const cur = init.order[init.current]!;
            log.push(engine.apply(attack(cur, cur === P ? A : P, 'unarmed')), engine.hash());
            log.push(engine.apply(endTurn(cur)), engine.hash());
          }
          const init = engine.snapshot().initiative;
          expect(init === null || init.round === startRound + 1).toBe(true);
          return log;
        };
        expect(run()).toEqual(run());
      }),
      { seed: 9, numRuns: 100 },
    );
  });
});
