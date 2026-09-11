import { SAVE_VERSION, type Diff, type Intent, type Snapshot } from '@deliberate/protocol';
import { describe, expect, it } from 'vitest';

import type { Engine } from '../engine.js';
import { hashSnapshot } from '../hash/index.js';
import { createEngine } from '../rules/create-engine.js';
import { createRng } from '../rules/rng.js';
import { fixtureSnapshot, FIXTURE_PLAYER_ID, FIXTURE_SEED } from '../store/index.js';
import { createSave, engineFromSave, saveFromJSON, SaveError, saveToJSON } from './save.js';

/**
 * ALE-23's acceptance evidence.
 *
 * Two properties, tested separately because passing one says nothing about the other:
 *
 * 1. **The hash comes back.** Trivially true of anything that round-trips the store.
 * 2. **The roll sequence comes back.** Not true of anything that round-trips the store, and the
 *    failure is invisible at the moment of loading: an engine rebuilt from the snapshot alone
 *    hashes identically and then rolls differently forever after. So the test that matters
 *    compares a save/load run against an uninterrupted one *roll for roll*, and a control run
 *    that drops the stream position is asserted to diverge — if it did not, the test would be
 *    proving nothing.
 *
 * And a third, which the hash also cannot see: cosmetic components are outside the digest and
 * inside the save, because a loaded game has to look right as well as hash right.
 */

const P = FIXTURE_PLAYER_ID;
const A = 'dummy-a';

const META = { room: 'main', turn: 3, seed: FIXTURE_SEED, savedAt: '2026-09-11T00:00:00.000Z' };

const attack = (): Intent => ({ kind: 'attack', attacker: P, target: A, ability: 'longsword' });
const endTurn = (): Intent => ({ kind: 'end_turn', entity: P });

/** The player toe to toe with a dummy tough enough to spar through a long session. */
function sparring(): Snapshot {
  const snapshot = fixtureSnapshot();
  const player = snapshot.entities[P]!.components.position!;
  player.x = 7;
  player.y = 3;
  snapshot.entities[A]!.components.health = { hp: 400, maxHp: 400, conditions: [] };
  return snapshot;
}

const boot = (snapshot: Snapshot = sparring()): Engine =>
  createEngine(snapshot, { seed: FIXTURE_SEED });

/** Twelve attacks with an `end_turn` between them: twenty-four intents, and a lot of dice. */
const SCRIPT: Intent[] = Array.from({ length: 12 }, () => [attack(), endTurn()]).flat();

/** Applies intents and returns the diffs each produced — where the rolls are visible as damage. */
function play(engine: Engine, intents: Intent[]): Diff[][] {
  return intents.map((intent) => {
    const verdict = engine.apply(intent);
    expect(verdict.ok, `${intent.kind} was rejected: ${verdict.reason ?? ''}`).toBe(true);
    return verdict.diff;
  });
}

/** A save that has actually been through JSON text, which is the only form that matters. */
const roundTrip = (engine: Engine, memory: Record<string, unknown> = {}) =>
  saveFromJSON(saveToJSON(createSave(engine, { ...META, memory })));

describe('rng stream position', () => {
  it('resumes a stream where it left off, in one step rather than by replaying it', () => {
    const straight = createRng(FIXTURE_SEED);
    for (let i = 0; i < 40; i++) straight.next();
    expect(straight.calls()).toBe(40);

    const resumed = createRng(FIXTURE_SEED, 40);
    expect(resumed.calls()).toBe(40);
    const rest = Array.from({ length: 40 }, () => straight.next());
    expect(Array.from({ length: 40 }, () => resumed.next())).toEqual(rest);
  });

  it('refuses a position that is not a count', () => {
    expect(() => createRng(FIXTURE_SEED, -1)).toThrow(RangeError);
    expect(() => createRng(FIXTURE_SEED, 1.5)).toThrow(RangeError);
  });
});

describe('save round trip', () => {
  it('restores the state hash through JSON text', () => {
    const engine = boot();
    play(engine, SCRIPT.slice(0, 8));
    const save = roundTrip(engine);

    expect(save.save).toBe(SAVE_VERSION);
    expect(save.hash).toBe(engine.hash());
    expect(engineFromSave(save).hash()).toBe(engine.hash());
  });

  it('restores cosmetic components, which the hash would not have missed', () => {
    const engine = boot();
    const save = roundTrip(engine);
    const loaded = engineFromSave(save);

    expect(loaded.snapshot()).toEqual(engine.snapshot());
    expect(loaded.snapshot().entities[A]!.components.portrait).toEqual({
      asset: 'portraits/dummy.png',
    });
    expect(loaded.snapshot().entities[A]!.components.dialogue).toEqual({ seeds: ['...'] });

    // The hash is blind here: drop the portrait and the digest does not move. So "same hash"
    // is not evidence the save is complete, and the deep comparison above is not redundant.
    const stripped = structuredClone(save.snapshot);
    delete stripped.entities[A]!.components.portrait;
    expect(hashSnapshot(stripped)).toBe(save.hash);
  });

  it('carries the GM memory blocks through unchanged and unaliased', () => {
    const memory = {
      ledger: [{ turn: 2, tool: 'attack', ok: false, reason: 'Ari is already dead.' }],
      world_model: ['The gate is barred.'],
      ledger_digest: { from_turn: 0, to_turn: 1, total: 4, applied: { move: 3 }, rejected: {} },
    };
    const save = roundTrip(boot(), memory);
    expect(save.memory).toEqual(memory);

    // The save took a copy: mutating the blocks the GM still holds must not edit the file.
    memory.world_model.push('smuggled in after the save');
    expect(save.memory['world_model']).toEqual(['The gate is barred.']);
  });

  it('keeps the room, the turn counter and the scene, so a resumed session continues its numbering', () => {
    const save = roundTrip(boot());
    expect(save.room).toBe('main');
    expect(save.turn).toBe(3);
    expect(save.scene).toBeNull();
    expect(createSave(boot(), { ...META, scene: 'gatehouse' }).scene).toBe('gatehouse');
  });
});

describe('save and the roll sequence', () => {
  it('a session saved and loaded mid-fight rolls exactly what it would have rolled', () => {
    const uninterrupted = boot();
    const everything = play(uninterrupted, SCRIPT);

    const interrupted = boot();
    const before = play(interrupted, SCRIPT.slice(0, 10));
    const save = roundTrip(interrupted);
    const resumed = engineFromSave(save);
    const after = play(resumed, SCRIPT.slice(10));

    // Not just the hash: every diff, which carries the damage the dice produced.
    expect([...before, ...after]).toEqual(everything);
    expect(resumed.hash()).toBe(uninterrupted.hash());
    expect(resumed.rngCalls()).toBe(uninterrupted.rngCalls());
  });

  it('and would not, if the save had carried the store alone', () => {
    const uninterrupted = boot();
    play(uninterrupted, SCRIPT);

    const interrupted = boot();
    play(interrupted, SCRIPT.slice(0, 10));
    const save = roundTrip(interrupted);

    // The control: everything the save has except where the dice had got to.
    const naive = createEngine(save.snapshot, { seed: save.seed });
    expect(naive.hash()).toBe(save.hash); // identical at the moment of loading...
    play(naive, SCRIPT.slice(10));
    expect(naive.hash()).not.toBe(uninterrupted.hash()); // ...and divergent from the next roll on.
    expect(naive.rngCalls()).toBeLessThan(uninterrupted.rngCalls());
  });
});

describe('a save this build cannot read', () => {
  it('is refused by version rather than half loaded', () => {
    const save = { ...roundTrip(boot()), save: SAVE_VERSION + 1 };
    expect(() => saveFromJSON(JSON.stringify(save))).toThrow(SaveError);
    expect(() => saveFromJSON(JSON.stringify(save))).toThrow(/save version 2 is not 1/);
  });

  it('is refused when it is not a save at all', () => {
    expect(() => saveFromJSON('{')).toThrow(/not valid JSON/);
    expect(() => saveFromJSON('{"save":1}')).toThrow(SaveError);
    expect(() => saveFromJSON(JSON.stringify({ ...roundTrip(boot()), memory: [] }))).toThrow(
      /memory must be an object/,
    );
    expect(() => saveFromJSON(JSON.stringify({ ...roundTrip(boot()), rngCalls: -1 }))).toThrow(
      /rngCalls/,
    );
  });

  it('is refused when the state does not hash to what the file claims', () => {
    const save = roundTrip(boot());
    save.snapshot.entities[A]!.components.health!.hp = 399;
    expect(() => engineFromSave(save)).toThrow(/but the file says/);
  });
});
