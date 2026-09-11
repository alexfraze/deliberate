import type { Health, Stats } from '@deliberate/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createStore, fixtureSnapshot, FIXTURE_PLAYER_ID } from '../store/index.js';
import { ABILITIES, abilityModifier, modifier, signed } from './abilities.js';
import {
  applyDamage,
  attackSources,
  resolveAttack,
  rollD20,
  rollDice,
  rollMode,
} from './attack.js';
import { CONDITIONS, isAlive, isIncapacitated } from './conditions.js';
import {
  actsOnItsOwn,
  advanceTurn,
  combatants,
  freshEconomy,
  rollInitiative,
} from './initiative.js';
import { createRng } from './rng.js';
import { attackAbility, getWeapon, inRange, isRangedAttack, WEAPONS } from './weapons.js';

const stats = (over: Partial<Stats> = {}): Stats => ({
  str: 10,
  dex: 10,
  con: 10,
  int: 10,
  wis: 10,
  cha: 10,
  ac: 10,
  speed: 30,
  proficiency: 2,
  ...over,
});
const health = (over: Partial<Health> = {}): Health => ({
  hp: 10,
  maxHp: 10,
  conditions: [],
  ...over,
});

describe('abilities', () => {
  it('has exactly the six SRD abilities and the SRD modifier table', () => {
    expect(ABILITIES).toEqual(['str', 'dex', 'con', 'int', 'wis', 'cha']);
    expect([1, 8, 9, 10, 11, 12, 13, 15, 20, 30].map(modifier)).toEqual([
      -5, -1, -1, 0, 0, 1, 1, 2, 5, 10,
    ]);
    expect(abilityModifier(stats({ dex: 17 }), 'dex')).toBe(3);
    expect(signed(3)).toBe('+3');
    expect(signed(0)).toBe('+0');
    expect(signed(-2)).toBe('-2');
  });
});

describe('conditions', () => {
  it('knows dead, unconscious, prone and derives alive/incapacitated from health', () => {
    expect(CONDITIONS).toEqual(['dead', 'unconscious', 'prone']);
    expect(isAlive(health())).toBe(true);
    expect(isAlive(health({ hp: 0 }))).toBe(false);
    expect(isAlive(health({ conditions: ['dead'] }))).toBe(false);
    expect(isAlive(undefined)).toBe(false);
    expect(isIncapacitated(health())).toBe(false);
    expect(isIncapacitated(health({ conditions: ['unconscious'] }))).toBe(true);
    expect(isIncapacitated(health({ conditions: ['prone'] }))).toBe(false);
    expect(isIncapacitated(health({ hp: 0 }))).toBe(true);
  });
});

describe('weapons', () => {
  it('resolves finesse to the better ability and range to reach or long range', () => {
    const dagger = getWeapon('dagger')!;
    expect(attackAbility(dagger, stats({ str: 12, dex: 16 }))).toBe('dex');
    expect(attackAbility(dagger, stats({ str: 16, dex: 12 }))).toBe('str');
    expect(attackAbility(getWeapon('longsword')!, stats({ dex: 20 }))).toBe('str');
    expect(inRange(getWeapon('longsword')!, 5)).toBe(true);
    expect(inRange(getWeapon('longsword')!, 10)).toBe(false);
    expect(inRange(dagger, 60)).toBe(true);
    expect(inRange(dagger, 65)).toBe(false);
    expect(isRangedAttack(dagger, 5)).toBe(false);
    expect(isRangedAttack(dagger, 10)).toBe(true);
    expect(isRangedAttack(getWeapon('shortbow')!, 5)).toBe(true);
    expect(getWeapon('hasOwnProperty')).toBeUndefined();
    expect(getWeapon('laser')).toBeUndefined();
    for (const w of Object.values(WEAPONS)) expect(WEAPONS[w.key]).toBe(w);
  });
});

describe('attack rolls', () => {
  const base = () => ({
    attacker: { stats: stats({ str: 16, proficiency: 2 }), health: health() },
    target: { stats: stats({ ac: 15 }), health: health() },
    weapon: getWeapon('longsword')!,
    distanceFt: 5,
    hostileAdjacent: false,
    offhand: false,
  });

  it('derives advantage and disadvantage from conditions, range and adjacency', () => {
    expect(rollMode(attackSources(base()))).toBe('normal');
    const unconscious = base();
    unconscious.target.health.conditions = ['unconscious'];
    expect(rollMode(attackSources(unconscious))).toBe('advantage');
    const proneNear = base();
    proneNear.target.health.conditions = ['prone'];
    expect(rollMode(attackSources(proneNear))).toBe('advantage');
    const proneFar = { ...base(), weapon: getWeapon('shortbow')!, distanceFt: 30 };
    proneFar.target.health.conditions = ['prone'];
    expect(rollMode(attackSources(proneFar))).toBe('disadvantage');
    const attackerProne = base();
    attackerProne.attacker.health.conditions = ['prone'];
    expect(rollMode(attackSources(attackerProne))).toBe('disadvantage');
    const bowAdjacent = { ...base(), weapon: getWeapon('shortbow')!, hostileAdjacent: true };
    expect(attackSources(bowAdjacent).disadvantage).toEqual(['hostile within 5 ft']);
    const longRange = { ...base(), weapon: getWeapon('shortbow')!, distanceFt: 100 };
    expect(attackSources(longRange).disadvantage).toEqual(['long range']);
    // Melee with a hostile adjacent: no penalty.
    expect(attackSources({ ...base(), hostileAdjacent: true }).disadvantage).toEqual([]);
    // One of each cancels.
    const both = base();
    both.attacker.health.conditions = ['prone'];
    both.target.health.conditions = ['unconscious'];
    expect(rollMode(attackSources(both))).toBe('normal');
  });

  it('advantage takes the higher d20, disadvantage the lower, normal rolls once', () => {
    fc.assert(
      fc.property(fc.string(), (seed) => {
        const a = rollD20(createRng(seed), 'advantage');
        const d = rollD20(createRng(seed), 'disadvantage');
        const n = rollD20(createRng(seed), 'normal');
        expect(a.rolled).toEqual(d.rolled);
        expect(a.natural).toBe(Math.max(...a.rolled));
        expect(d.natural).toBe(Math.min(...d.rolled));
        expect(n.rolled).toEqual([a.rolled[0]]);
      }),
      { seed: 9 },
    );
  });

  it('rollDice sums count*times dice plus the flat part', () => {
    expect(rollDice(createRng('x'), { count: 0, sides: 0, flat: 1 })).toBe(1);
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 3 }),
        (seed, count, times) => {
          const total = rollDice(createRng(seed), { count, sides: 6 }, times);
          expect(total).toBeGreaterThanOrEqual(count * times);
          expect(total).toBeLessThanOrEqual(6 * count * times);
        },
      ),
      { seed: 9 },
    );
  });

  it('hits when total >= AC, a natural 20 always hits with double dice, a natural 1 always misses', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 30 }), (seed, ac) => {
        const ctx = base();
        ctx.target.stats.ac = ac;
        const r = resolveAttack(createRng(seed), ctx);
        expect(r.attackBonus).toBe(3 + 2);
        expect(r.total).toBe(r.natural + 5);
        if (r.natural === 20) expect(r.hit && r.critical).toBe(true);
        else if (r.natural === 1) expect(r.hit).toBe(false);
        else expect(r.hit).toBe(r.total >= ac);
        if (r.hit) {
          // longsword 1d8 (+3 STR), doubled dice on a critical
          const dice = r.critical ? 2 : 1;
          expect(r.damage).toBeGreaterThanOrEqual(dice * 1 + 3);
          expect(r.damage).toBeLessThanOrEqual(dice * 8 + 3);
        } else {
          expect(r.damage).toBe(0);
        }
      }),
      { seed: 9, numRuns: 300 },
    );
  });

  it('off-hand attacks drop a positive modifier from damage but keep a negative one', () => {
    fc.assert(
      fc.property(fc.string(), (seed) => {
        const strong = { ...base(), weapon: getWeapon('dagger')!, offhand: true };
        strong.target.stats.ac = 0;
        const r = resolveAttack(createRng(seed), strong);
        if (r.hit) {
          expect(r.damage).toBeGreaterThanOrEqual(1);
          expect(r.damage).toBeLessThanOrEqual(r.critical ? 8 : 4);
        }
        const weak = { ...base(), weapon: getWeapon('dagger')!, offhand: true };
        weak.attacker.stats = stats({ str: 6, dex: 6 });
        weak.target.stats.ac = 0;
        const w = resolveAttack(createRng(seed), weak);
        if (w.hit) expect(w.damage).toBeLessThanOrEqual(Math.max(0, (w.critical ? 8 : 4) - 2));
      }),
      { seed: 9 },
    );
  });

  it('is deterministic for a seed', () => {
    const a = resolveAttack(createRng('same'), base());
    const b = resolveAttack(createRng('same'), base());
    expect(a).toEqual(b);
  });

  it('applyDamage spends temporary HP first and floors HP at 0', () => {
    expect(applyDamage(health({ hp: 10, tempHp: 3 }), 5)).toEqual(health({ hp: 8, tempHp: 0 }));
    expect(applyDamage(health({ hp: 10, tempHp: 3 }), 2)).toEqual(health({ hp: 10, tempHp: 1 }));
    expect(applyDamage(health({ hp: 4 }), 9)).toEqual(health({ hp: 0 }));
    expect(applyDamage(health(), 0)).toEqual(health());
  });
});

describe('initiative', () => {
  it('rolls d20 + DEX for every living combatant, highest first, ties by DEX then id', () => {
    const store = createStore(fixtureSnapshot());
    store.setComponent('dummy-b', 'health', health({ hp: 0 }));
    expect(combatants(store)).toEqual(['dummy-a', FIXTURE_PLAYER_ID]);
    fc.assert(
      fc.property(fc.string(), (seed) => {
        const rolls = rollInitiative(store, createRng(seed));
        expect(rolls.map((r) => r.entity).sort()).toEqual(['dummy-a', FIXTURE_PLAYER_ID]);
        for (let i = 1; i < rolls.length; i++) {
          expect(rolls[i - 1]!.total).toBeGreaterThanOrEqual(rolls[i]!.total);
        }
        const player = rolls.find((r) => r.entity === FIXTURE_PLAYER_ID)!;
        expect(player.total).toBe(player.roll + 2); // DEX 14
        expect(rollInitiative(store, createRng(seed))).toEqual(rolls);
      }),
      { seed: 9 },
    );
    // Tie: same total, higher DEX first; same DEX, id order.
    const tie = createStore(fixtureSnapshot());
    for (const id of tie.entityIds()) tie.setComponent(id, 'stats', stats({ dex: 10 }));
    tie.setComponent('dummy-b', 'stats', stats({ dex: 11 }));
    const fixed = { next: () => 0.5, int: () => 10, roll: () => 10, calls: () => 0 };
    expect(rollInitiative(tie, fixed).map((r) => r.entity)).toEqual([
      'dummy-b',
      'dummy-a',
      FIXTURE_PLAYER_ID,
    ]);
  });

  it('advanceTurn skips the dead and non-player brains, wraps rounds, ends with nobody left', () => {
    const store = createStore(fixtureSnapshot());
    const init = {
      order: [FIXTURE_PLAYER_ID, 'dummy-a', 'dummy-b'],
      current: 0,
      round: 1,
      turn: freshEconomy(),
    };
    const next = advanceTurn(store, init);
    expect(next.skipped).toEqual(['dummy-a', 'dummy-b']);
    expect(next.roundsPassed).toBe(1);
    expect(next.state).toEqual({ ...init, round: 2, turn: freshEconomy() });

    store.setComponent('dummy-a', 'brain', { policy: 'player' });
    const two = advanceTurn(store, {
      ...init,
      turn: { movedFt: 30, actionUsed: true, bonusActionUsed: true },
    });
    expect(two.state).toEqual({ ...init, current: 1, turn: freshEconomy() });
    expect(two.roundsPassed).toBe(0);

    store.setComponent('dummy-a', 'health', health({ hp: 0, conditions: ['dead'] }));
    store.setComponent(FIXTURE_PLAYER_ID, 'health', health({ hp: 0 }));
    const over = advanceTurn(store, init);
    expect(over.state).toBeNull();
    expect(over.skipped).toHaveLength(3);
  });

  it('stops on a `gm` brain, so the game master can be asked what that entity does', () => {
    // ALE-32. The NPCs in content/npcs all carry `brain.policy: 'gm'`; if initiative stepped over
    // them the way it steps over scenery, no NPC would ever take a turn in an encounter.
    const store = createStore(fixtureSnapshot());
    store.setComponent('dummy-a', 'brain', { policy: 'gm' });
    expect(actsOnItsOwn(store, 'dummy-a')).toBe(true);
    expect(actsOnItsOwn(store, 'dummy-b')).toBe(false);

    const init = {
      order: [FIXTURE_PLAYER_ID, 'dummy-a', 'dummy-b'],
      current: 0,
      round: 1,
      turn: freshEconomy(),
    };
    const next = advanceTurn(store, init);
    expect(next.state?.current).toBe(1);
    expect(next.skipped).toEqual([]);
  });
});
