import {
  GM_MUTATION_TOOL_NAMES,
  GM_QUERY_TOOL_NAMES,
  GM_TOOLS,
  type Entity,
  type GmToolCall,
  type Intent,
  type Snapshot,
} from '@deliberate/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { apply } from '../diffs/index.js';
import type { Engine } from '../engine.js';
import { createEngine } from '../rules/create-engine.js';
import { createRng } from '../rules/rng.js';
import {
  FIXTURE_DUMMY_IDS,
  FIXTURE_MAP_ID,
  FIXTURE_PLAYER_ID,
  FIXTURE_SEED,
  fixtureDummy,
  fixtureSnapshot,
} from '../store/index.js';
import { executeGmBatch, executeGmTool } from './execute.js';
import { toIntent } from './execute.js';

const PLAYER = FIXTURE_PLAYER_ID;
const [DUMMY_A, DUMMY_B] = FIXTURE_DUMMY_IDS;

/** A goblin template for `spawn`, and a caster who knows a cantrip, over the M0 fixture. */
function templates(): Record<string, Entity> {
  return { goblin: fixtureDummy('goblin-template', 'Goblin', 0, 0) };
}

function engineWith(snapshot: Snapshot = fixtureSnapshot()): Engine {
  return createEngine(snapshot, { seed: FIXTURE_SEED, templates: templates() });
}

function call(name: string, args: Record<string, unknown>): GmToolCall {
  return { name, args };
}

describe('GM tool executor', () => {
  let engine: Engine;
  beforeEach(() => {
    engine = engineWith();
  });

  it('exposes a handler for every tool in the contract', () => {
    for (const tool of GM_TOOLS) {
      const result = executeGmTool(engine, call(tool.name, {}));
      // Every tool is reachable: the reply is the schema complaining about missing arguments,
      // never "there is no tool called ...".
      expect(result.ok).toBe(false);
      expect(result.reason).not.toMatch(/no tool called/);
    }
  });

  it('rejects a tool that is not in the contract', () => {
    const before = engine.hash();
    const result = executeGmTool(engine, call('rewrite_reality', { truth: 'mine' }));
    expect(result).toEqual({
      ok: false,
      reason: 'There is no tool called rewrite_reality.',
      diff: [],
    });
    expect(engine.hash()).toBe(before);
  });

  it("the contract's mutation kinds are exactly the tools that map to intents", () => {
    // Self-checking in both directions: a `kind: "mutation"` entry with no intent mapping, or an
    // intent mapping for something the file calls a query, fails here.
    const declared = GM_TOOLS.filter((t) => t.kind === 'mutation')
      .map((t) => t.name)
      .sort();
    const mapped = GM_TOOLS.filter((t) => toIntent(t.name, {}) !== null)
      .map((t) => t.name)
      .sort();
    expect(mapped).toEqual(declared);
    expect(declared).toEqual([...GM_MUTATION_TOOL_NAMES].sort());
  });

  it('maps each mutation tool onto exactly one intent kind', () => {
    const kinds = new Set<Intent['kind']>();
    const args: Record<string, Record<string, unknown>> = {
      move: { entity_id: PLAYER, to: { x: 3, y: 2 } },
      attack: { attacker: PLAYER, target: DUMMY_A, ability: 'longsword' },
      cast: { entity_id: PLAYER, spell: 'fire_bolt', target: DUMMY_A },
      say: { npc_id: PLAYER, text: 'hello', to: null },
      set_disposition: { npc_id: PLAYER, toward: DUMMY_A, delta: 5, reason: 'why' },
      spawn: { template_id: 'goblin', at: { x: 4, y: 4 }, map: null, entity_id: null },
      set_flag: { key: 'k', value: true },
      advance_quest: { quest_id: 'first-blood', step: 1 },
      end_turn: { entity_id: PLAYER },
      author_map: {
        map_id: 'north-road',
        width: 8,
        height: 6,
        terrain: ['########', '#......#', '#......#', '#......#', '#......#', '########'],
        back: { at: [6, 4], to: FIXTURE_MAP_ID, arrive: [1, 1], label: 'the way back' },
        frontiers: [],
        objectives: [],
      },
    };
    for (const name of GM_MUTATION_TOOL_NAMES) {
      const intent = toIntent(name, args[name]!);
      expect(intent, name).not.toBeNull();
      kinds.add(intent!.kind);
    }
    expect(kinds.size).toBe(GM_MUTATION_TOOL_NAMES.length);
  });
});

describe('rejected calls leave the world untouched', () => {
  // The heart of ALE-31: assert by state hash, not by poking at fields. If any rejected path
  // wrote before it checked, the hash moves and this fails.
  const rejections: [string, Record<string, unknown>][] = [
    ['move', { entity_id: PLAYER, to: { x: 0, y: 0 } }],
    ['move', { entity_id: 'nobody', to: { x: 3, y: 3 } }],
    ['move', { entity_id: PLAYER, to: { x: 99, y: 99 } }],
    ['attack', { attacker: PLAYER, target: DUMMY_A, ability: 'longsword' }],
    ['attack', { attacker: PLAYER, target: DUMMY_A, ability: 'trebuchet' }],
    ['attack', { attacker: PLAYER, target: PLAYER, ability: 'longsword' }],
    ['cast', { entity_id: PLAYER, spell: 'fire_bolt', target: DUMMY_A }],
    ['cast', { entity_id: PLAYER, spell: 'wish', target: DUMMY_A }],
    ['say', { npc_id: 'nobody', text: 'hello', to: null }],
    ['say', { npc_id: PLAYER, text: '   ', to: null }],
    ['say', { npc_id: PLAYER, text: 'hello', to: 'nobody' }],
    ['set_disposition', { npc_id: PLAYER, toward: PLAYER, delta: 5, reason: 'vanity' }],
    ['set_disposition', { npc_id: PLAYER, toward: 'nobody', delta: 5, reason: 'r' }],
    ['set_disposition', { npc_id: PLAYER, toward: DUMMY_A, delta: 0, reason: 'r' }],
    ['spawn', { template_id: 'dragon', at: { x: 4, y: 4 }, map: null, entity_id: null }],
    ['spawn', { template_id: 'goblin', at: { x: 0, y: 0 }, map: null, entity_id: null }],
    ['spawn', { template_id: 'goblin', at: { x: 8, y: 3 }, map: null, entity_id: null }],
    ['spawn', { template_id: 'goblin', at: { x: 4, y: 4 }, map: 'atlantis', entity_id: null }],
    ['spawn', { template_id: 'goblin', at: { x: 4, y: 4 }, map: null, entity_id: PLAYER }],
    ['set_flag', { key: 'tutorial', value: true }],
    ['set_flag', { key: '   ', value: true }],
    ['advance_quest', { quest_id: 'nonesuch', step: 1 }],
    ['advance_quest', { quest_id: 'first-blood', step: 0 }],
    ['advance_quest', { quest_id: 'first-blood', step: 9 }],
    ['end_turn', { entity_id: PLAYER }],
    // Schema rejections never reach the engine at all.
    ['move', { entity_id: PLAYER }],
    ['move', { entity_id: PLAYER, to: { x: 3, y: 2 }, sneakily: true }],
    ['move', { entity_id: PLAYER, to: { x: 1.5, y: 2 } }],
    ['set_flag', { key: 'k', value: { nested: 'object' } }],
    ['recall', { topic: '', limit: 5 }],
    ['get_state', { scope: 'everything', entity_id: null }],
    ['path', { a: { x: 1, y: 1 }, b: { x: 2, y: 2 }, max_cost: 0, map: null }],
  ];

  it.each(rejections)('%s %j is refused and changes nothing', (name, args) => {
    const engine = engineWith();
    const before = engine.hash();
    const snapshotBefore = engine.snapshot();
    const result = executeGmTool(engine, call(name, args));
    expect(result.ok, `${name} should have been refused: ${JSON.stringify(result)}`).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.diff).toEqual([]);
    expect(engine.hash()).toBe(before);
    expect(engine.snapshot()).toEqual(snapshotBefore);
  });

  it('gives a reason a player could read', () => {
    const engine = engineWith();
    const result = executeGmTool(
      engine,
      call('attack', { attacker: PLAYER, target: DUMMY_A, ability: 'longsword' }),
    );
    expect(result.reason).toBe('Training Dummy A is 30 ft away; a longsword reaches 5 ft.');
  });
});

describe('queries are free', () => {
  const queries: [string, Record<string, unknown>][] = [
    ['get_state', { scope: 'all', entity_id: null }],
    ['get_state', { scope: 'world', entity_id: null }],
    ['get_state', { scope: 'entities', entity_id: PLAYER }],
    ['get_state', { scope: 'initiative', entity_id: null }],
    ['get_state', { scope: 'map', entity_id: null }],
    ['legal_actions', { entity_id: PLAYER }],
    ['line_of_sight', { a: { x: 2, y: 2 }, b: { x: 8, y: 3 }, map: null }],
    ['path', { a: { x: 2, y: 2 }, b: { x: 7, y: 3 }, max_cost: 20, map: null }],
    ['recall', { topic: 'blood', limit: 10 }],
    [
      'roll_preview',
      { action: { kind: 'attack', attacker: PLAYER, target: DUMMY_A, ability: 'longsword' } },
    ],
  ];

  it.each(queries)('%s %j answers without touching the world', (name, args) => {
    const engine = engineWith();
    const before = engine.hash();
    const snapshotBefore = engine.snapshot();
    const result = executeGmTool(engine, call(name, args));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.diff).toEqual([]);
    expect(result.data).toBeDefined();
    expect(engine.hash()).toBe(before);
    expect(engine.snapshot()).toEqual(snapshotBefore);
  });

  it('covers every query tool in the contract', () => {
    expect(new Set(queries.map(([name]) => name))).toEqual(new Set(GM_QUERY_TOOL_NAMES));
  });

  it('reports odds, not a roll, and says the target it can reach', () => {
    const engine = engineWith();
    // Step next to dummy A first so the attack is legal.
    walkTo(engine, PLAYER, { x: 7, y: 3 });
    const result = executeGmTool(
      engine,
      call('roll_preview', {
        action: { kind: 'attack', attacker: PLAYER, target: DUMMY_A, ability: 'longsword' },
      }),
    );
    const data = result.data as Record<string, number | string | boolean>;
    expect(data['legal']).toBe(true);
    // +3 STR, +2 proficiency against AC 10: naturals 5..20 hit, so 16/20.
    expect(data['attackBonus']).toBe(5);
    expect(data['targetAc']).toBe(10);
    expect(data['hitChance']).toBe(0.8);
    expect(data['critChance']).toBe(0.05);
    // 1d8 averages 4.5, +3 STR.
    expect(data['averageDamageOnHit']).toBe(7.5);
  });

  it('explains an illegal action instead of pricing it', () => {
    const engine = engineWith();
    const result = executeGmTool(
      engine,
      call('roll_preview', {
        action: { kind: 'cast', attacker: PLAYER, target: DUMMY_A, ability: 'fire_bolt' },
      }),
    );
    expect(result.ok).toBe(true);
    expect((result.data as { legal: boolean; reason: string }).legal).toBe(false);
    expect((result.data as { reason: string }).reason).toBe('Player does not know fire bolt.');
  });

  it('lists legal moves and the reason each attack is refused', () => {
    const engine = engineWith();
    const data = executeGmTool(engine, call('legal_actions', { entity_id: PLAYER })).data as {
      move: { ok: boolean; remainingFt: number; tiles: unknown[] };
      attack: { target: string; ability: string; ok: boolean; reason?: string }[];
    };
    expect(data.move.ok).toBe(true);
    expect(data.move.remainingFt).toBe(30);
    expect(data.move.tiles.length).toBeGreaterThan(0);
    const longsword = data.attack.find((a) => a.target === DUMMY_A && a.ability === 'longsword');
    expect(longsword).toEqual({
      target: DUMMY_A,
      name: 'Training Dummy A',
      ability: 'longsword',
      distanceFt: 30,
      ok: false,
      reason: 'Training Dummy A is 30 ft away; a longsword reaches 5 ft.',
    });
  });
});

describe('roll_preview does not disturb the seeded RNG', () => {
  /**
   * The determinism proof. A preview that sampled the stream — even from a "copy" obtained by
   * peeking — would shift the next real roll, recorded sessions would stop replaying to identical
   * hashes, and M0's exit criterion would be gone. `rollPreview` never receives an `Rng` at all,
   * and these tests pin that behaviour from the outside: the observable roll sequence has to be
   * byte-identical whether or not previews were taken.
   */
  function fight(
    engine: Engine,
    previewBetween: boolean,
  ): { hashes: string[]; damage: number[]; rolls: string[] } {
    walkTo(engine, PLAYER, { x: 7, y: 3 });
    const hashes: string[] = [];
    const damage: number[] = [];
    // Every diff of every swing, verbatim: hit or miss, the amount, the initiative order the
    // opening roll produced. This is the observable image of the RNG stream.
    const rolls: string[] = [];
    for (let i = 0; i < 6; i++) {
      if (previewBetween) {
        // Ask for odds repeatedly, from several angles, before every single swing.
        for (const target of [DUMMY_A, DUMMY_B]) {
          executeGmTool(
            engine,
            call('roll_preview', {
              action: { kind: 'attack', attacker: PLAYER, target, ability: 'longsword' },
            }),
          );
        }
        executeGmTool(engine, call('legal_actions', { entity_id: PLAYER }));
        executeGmTool(engine, call('get_state', { scope: 'all', entity_id: null }));
      }
      const result = executeGmTool(
        engine,
        call('attack', { attacker: PLAYER, target: DUMMY_A, ability: 'longsword' }),
      );
      rolls.push(JSON.stringify(result.diff));
      for (const diff of result.diff) {
        if (diff.type === 'DamageApplied') damage.push(diff.amount);
      }
      const ended = executeGmTool(engine, call('end_turn', { entity_id: PLAYER }));
      rolls.push(JSON.stringify(ended.diff));
      hashes.push(engine.hash());
    }
    return { hashes, damage, rolls };
  }

  it('leaves the state hash AND the whole subsequent roll sequence identical', () => {
    const clean = fight(engineWith(), false);
    const previewed = fight(engineWith(), true);
    // The hash alone would pass even if the stream had advanced, so the roll sequence itself is
    // compared too: every diff of every swing, hit or miss, in order.
    expect(previewed.rolls).toEqual(clean.rolls);
    expect(previewed.damage).toEqual(clean.damage);
    expect(previewed.hashes).toEqual(clean.hashes);
    // The fight has to actually roll for any of this to mean anything.
    expect(clean.damage.length).toBeGreaterThan(0);
    expect(new Set(clean.damage).size).toBeGreaterThan(1);
    expect(new Set(clean.hashes).size).toBe(clean.hashes.length);
  });

  it('leaves the hash untouched across a single preview', () => {
    const engine = engineWith();
    walkTo(engine, PLAYER, { x: 7, y: 3 });
    const before = engine.hash();
    for (let i = 0; i < 50; i++) {
      executeGmTool(
        engine,
        call('roll_preview', {
          action: { kind: 'attack', attacker: PLAYER, target: DUMMY_A, ability: 'longsword' },
        }),
      );
    }
    expect(engine.hash()).toBe(before);
  });

  it('a single stolen roll would have been caught: the stream never realigns', () => {
    // The negative control for the two tests above. If `roll_preview` consumed even one number,
    // every later roll would shift, which is exactly what this shows — so the equality assertions
    // are sensitive to stream position, not vacuously true.
    const untouched = createRng(FIXTURE_SEED);
    const shifted = createRng(FIXTURE_SEED);
    shifted.roll(20);
    const a = Array.from({ length: 20 }, () => untouched.roll(20));
    const b = Array.from({ length: 20 }, () => shifted.roll(20));
    expect(b).not.toEqual(a);
  });

  it('the preview is consistent with the rolls it predicts', () => {
    // A sanity check on the closed form: over many rolls of the engine's own RNG, the share that
    // would hit lands on the predicted 0.8. Uses a seeded Rng, so this never flakes.
    const rng = createRng('roll-preview-sanity');
    let hits = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const natural = rng.roll(20);
      if (natural === 20 || (natural !== 1 && natural + 5 >= 10)) hits++;
    }
    expect(Math.abs(hits / n - 0.8)).toBeLessThan(0.02);
  });
});

describe('mutations go through the same validated path the UI uses', () => {
  it('say emits a dialogue line and moves nothing', () => {
    const engine = engineWith();
    const before = engine.hash();
    const result = executeGmTool(
      engine,
      call('say', { npc_id: DUMMY_A, text: '  ...  ', to: PLAYER }),
    );
    expect(result.ok).toBe(true);
    expect(result.diff).toEqual([
      { type: 'DialogueLine', speaker: DUMMY_A, text: '...', to: PLAYER },
    ]);
    expect(engine.hash()).toBe(before);
  });

  it('set_disposition clamps and records why', () => {
    const engine = engineWith();
    const first = executeGmTool(
      engine,
      call('set_disposition', { npc_id: DUMMY_A, toward: PLAYER, delta: 150, reason: 'spared it' }),
    );
    expect(first.diff).toEqual([
      {
        type: 'DispositionChanged',
        entity: DUMMY_A,
        toward: PLAYER,
        value: 100,
        reason: 'spared it',
      },
    ]);
    // Already pinned at the maximum: a second nudge would change nothing, so it is refused.
    const before = engine.hash();
    const second = executeGmTool(
      engine,
      call('set_disposition', { npc_id: DUMMY_A, toward: PLAYER, delta: 10, reason: 'again' }),
    );
    expect(second.ok).toBe(false);
    expect(engine.hash()).toBe(before);
  });

  it('spawn places a known template and refuses an unknown one by name', () => {
    const engine = engineWith();
    const result = executeGmTool(
      engine,
      call('spawn', { template_id: 'goblin', at: { x: 5, y: 7 }, map: null, entity_id: null }),
    );
    expect(result.ok).toBe(true);
    const spawned = engine.snapshot().entities['goblin-1'];
    expect(spawned?.components.position).toMatchObject({ map: FIXTURE_MAP_ID, x: 5, y: 7 });
    const refused = executeGmTool(
      engine,
      call('spawn', { template_id: 'dragon', at: { x: 5, y: 8 }, map: null, entity_id: null }),
    );
    expect(refused.reason).toBe('There is no template called dragon. Known templates: goblin.');
  });

  it('cast resolves as a spell attack for a caster who knows the cantrip', () => {
    const snapshot = fixtureSnapshot();
    const player = snapshot.entities[PLAYER]!;
    player.components.inventory = { items: [{ item: 'fire_bolt', qty: 1 }] };
    const engine = createEngine(snapshot, { seed: FIXTURE_SEED, templates: templates() });
    const result = executeGmTool(
      engine,
      call('cast', { entity_id: PLAYER, spell: 'fire_bolt', target: DUMMY_A }),
    );
    expect(result.ok, result.reason).toBe(true);
    // A cast is an attack: it starts the encounter and spends the action, exactly like a swing.
    expect(result.diff.map((d) => d.type)).toContain('TurnAdvanced');
    expect(result.diff.map((d) => d.type)).toContain('EconomySpent');
  });

  it('advance_quest only moves forward', () => {
    const engine = engineWith();
    expect(
      executeGmTool(engine, call('advance_quest', { quest_id: 'first-blood', step: 1 })).ok,
    ).toBe(true);
    expect(engine.snapshot().world.quests['first-blood']?.step).toBe(1);
    const back = executeGmTool(engine, call('advance_quest', { quest_id: 'first-blood', step: 0 }));
    expect(back.reason).toBe('"First blood" is already at step 1; quests only move forward.');
  });

  it('every diff a mutation emits folds back to the engine state', () => {
    // apply(snapshot, diffs) must reproduce the engine, including the two diffs ALE-31 added.
    const engine = engineWith();
    let state = engine.snapshot();
    const calls: GmToolCall[] = [
      call('set_flag', { key: 'met-the-gm', value: true }),
      call('advance_quest', { quest_id: 'first-blood', step: 1 }),
      call('set_disposition', { npc_id: DUMMY_A, toward: PLAYER, delta: -20, reason: 'stabbed' }),
      call('say', { npc_id: DUMMY_A, text: 'ow', to: PLAYER }),
      call('spawn', { template_id: 'goblin', at: { x: 5, y: 7 }, map: null, entity_id: 'gob' }),
      call('move', { entity_id: PLAYER, to: { x: 4, y: 2 } }),
    ];
    for (const c of calls) {
      const result = executeGmTool(engine, c);
      expect(result.ok, `${c.name}: ${result.reason}`).toBe(true);
      state = apply(state, result.diff);
    }
    expect(state).toEqual(engine.snapshot());
  });
});

describe('batches stop at the first rejection', () => {
  it('does not attempt anything after a refusal', () => {
    const engine = engineWith();
    const batch = executeGmBatch(engine, [
      call('set_flag', { key: 'one', value: 1 }),
      call('advance_quest', { quest_id: 'nonesuch', step: 1 }),
      call('set_flag', { key: 'three', value: 3 }),
    ]);
    expect(batch.rejectedAt).toBe(1);
    expect(batch.results).toHaveLength(2);
    const flags = engine.snapshot().world.flags;
    expect(flags['one']).toBe(1);
    expect(flags['three']).toBeUndefined();
  });

  it('reports no rejection when every call lands', () => {
    const engine = engineWith();
    const batch = executeGmBatch(engine, [
      call('get_state', { scope: 'world', entity_id: null }),
      call('set_flag', { key: 'one', value: 1 }),
    ]);
    expect(batch.rejectedAt).toBeNull();
    expect(batch.results.every((r) => r.ok)).toBe(true);
  });
});

/** Walk `entity` to a tile, asserting the engine allowed it. Keeps the tests' setup honest. */
function walkTo(engine: Engine, entity: string, to: { x: number; y: number }): void {
  const result = executeGmTool(engine, call('move', { entity_id: entity, to }));
  if (!result.ok) throw new Error(`setup move failed: ${result.reason}`);
}
