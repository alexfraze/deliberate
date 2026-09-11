import {
  bankExpectation,
  createEngine,
  createRecorder,
  executeGmTool,
  fixtureSnapshot,
  memorySink,
  FIXTURE_DUMMY_IDS,
  FIXTURE_PLAYER_ID,
  FIXTURE_SEED,
  parseRecording,
  type BankObjective,
  type BankSession,
  type Engine,
} from '@deliberate/engine';
import {
  GATEHOUSE_SEED,
  GUARD_ID,
  MERCHANT_ID,
  NPC_ARCHETYPES,
  SCOUT_ID,
  gatehouseSnapshot,
  npcEntity,
} from '@deliberate/npcs';
import {
  type Entity,
  type EntityId,
  type GmToolCall,
  type Intent,
  type Seed,
  type Snapshot,
  type Verdict,
} from '@deliberate/protocol';

/**
 * The generated half of the regression bank (ALE-21).
 *
 * The bank's first entry was a real ten-turn playthrough against `claude-opus-5`, which cost money
 * and took half an hour. These four cost nothing: they are played by scripted intents against the
 * seeded engine, so they are reproducible on any machine with no key and no network, and the test
 * beside this file regenerates them and holds the result to the committed bytes.
 *
 * What they are for is coverage the live session does not have. The recorded playthrough never
 * killed anyone, never spawned anything, never ran initiative past the first round, and refused
 * exactly one call. So:
 *
 * | session                   | what it is in the bank to catch                                |
 * | ------------------------- | -------------------------------------------------------------- |
 * | `m0-yard-skirmish`        | a death: damage, the `dead` condition, and a corpse refusing    |
 * | `gatehouse-refusals`      | every mutation kind refused; a session that changes nothing     |
 * | `gatehouse-initiative`    | an encounter wrapping initiative twice with four combatants     |
 * | `gatehouse-gm-tools`      | all nine mutation tools through `executeGmTool`, spawn included |
 *
 * Nothing here is a second implementation of anything: the intents go through `Engine.apply`, and
 * the tool calls go through `executeGmTool` against an engine facade shaped exactly like the one
 * `room.commitGmCall` hands it, so a recorded tool call is the same artifact the server writes.
 */

/** The recorder's one input from outside the engine. Fixed, so the bytes are reproducible. */
const STARTED_AT = '2026-01-01T00:00:00.000Z';

/** The gatehouse templates the server runs with: `spawn` can instantiate any of the three. */
const GATEHOUSE_TEMPLATES: Record<string, Entity> = Object.fromEntries(
  NPC_ARCHETYPES.map((npc) => [npc.archetype, npcEntity(npc)]),
);

const PLAYER: EntityId = FIXTURE_PLAYER_ID;

/** What a session's script can do. Both roads end at `Engine.apply`; only the record differs. */
interface Play {
  readonly engine: Engine;
  /** A player-side intent: recorded with no tool call behind it, like a UI commit. */
  apply(intent: Intent): Verdict;
  /** A game-master tool call: validated against the contract, then recorded beside its verdict. */
  tool(name: string, args: Record<string, unknown>): Verdict;
}

interface Scenario {
  name: string;
  description: string;
  objective: BankObjective;
  snapshot: Snapshot;
  seed: Seed;
  templates?: Record<string, Entity>;
  play(play: Play): void;
}

export interface GeneratedSession {
  session: BankSession;
  /** The recording, exactly as it belongs on disk. */
  jsonl: string;
}

// ---------------------------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------------------------

const [DUMMY_A] = FIXTURE_DUMMY_IDS;

const SCENARIOS: Scenario[] = [
  {
    name: 'm0-yard-skirmish',
    description:
      'The M0 yard: the player closes on a training dummy and beats it to death, ending turns ' +
      'between swings so initiative wraps the round. Covers damage, the dead condition, the ' +
      'world clock, and a refusal to attack a corpse — none of which the live session contains.',
    objective: { type: 'ConditionSet', where: { condition: 'dead', active: true } },
    snapshot: fixtureSnapshot(),
    seed: FIXTURE_SEED,
    play({ engine, apply }) {
      apply({ kind: 'move', entity: PLAYER, to: { x: 7, y: 2 } });
      // Swing, end the turn, swing again. The dummy has no acting brain, so `end_turn` steps over
      // it and comes back round to the player with a fresh action and the clock one round on.
      for (let i = 0; i < 12 && alive(engine.snapshot(), DUMMY_A!); i += 1) {
        apply({ kind: 'attack', attacker: PLAYER, target: DUMMY_A!, ability: 'longsword' });
        apply({ kind: 'end_turn', entity: PLAYER });
      }
      // The corpse refuses. A rejection changes nothing and says why.
      apply({ kind: 'attack', attacker: PLAYER, target: DUMMY_A!, ability: 'longsword' });
    },
  },
  {
    name: 'gatehouse-refusals',
    description:
      'One refusal for every mutation the engine knows, and nothing else. The final hash is the ' +
      'hash it started with, which is the engine contract stated as a whole session: a rejected ' +
      'intent touches nothing. A rule that starts quietly accepting one of these fails here.',
    objective: { type: 'FlagSet' },
    snapshot: gatehouseSnapshot(),
    seed: GATEHOUSE_SEED,
    play({ apply }) {
      apply({ kind: 'move', entity: PLAYER, to: { x: 0, y: 0 } }); // a wall
      apply({ kind: 'attack', attacker: PLAYER, target: SCOUT_ID, ability: 'longsword' }); // 40 ft
      apply({ kind: 'cast', caster: PLAYER, spell: 'fire_bolt', target: GUARD_ID }); // unknown
      apply({ kind: 'say', speaker: 'nobody', text: 'I am not here.', to: null });
      apply({
        kind: 'set_disposition',
        entity: GUARD_ID,
        toward: GUARD_ID, // toward themself
        delta: 10,
        reason: 'a guard cannot feel a way about himself',
      });
      apply({ kind: 'spawn', template: 'guard', at: { x: 6, y: 1 }, map: null, id: null }); // no templates
      apply({ kind: 'set_flag', key: 'gatehouse.gate.sealed', value: true }); // already true
      apply({ kind: 'advance_quest', quest: 'carry-the-scout', step: 0 }); // not forward
      apply({ kind: 'end_turn', entity: PLAYER }); // no encounter
    },
  },
  {
    name: 'gatehouse-initiative',
    description:
      'A four-combatant encounter driven to the top of round three: every NPC in the gatehouse ' +
      'takes a turn, initiative wraps twice and the world clock follows it. The live session ' +
      'never got past the round it started, so nothing else in the bank covers the wrap.',
    objective: { type: 'TurnAdvanced', where: { 'initiative.round': 3 } },
    snapshot: gatehouseSnapshot(),
    seed: GATEHOUSE_SEED,
    play({ engine, apply }) {
      // Straight up the west wall to the tile beside Ilva: the low wall at (3, 7) cuts the
      // diagonal line of sight, so the player has to stand square on to her to swing.
      apply({ kind: 'move', entity: PLAYER, to: { x: 2, y: 6 } });
      apply({ kind: 'attack', attacker: PLAYER, target: MERCHANT_ID, ability: 'longsword' });
      // Whoever initiative stops on ends their turn. Every NPC here has a `gm` brain, so the
      // order really does stop on all four, and the round only moves when it runs off the end.
      for (let i = 0; i < 12; i += 1) {
        const init = engine.snapshot().initiative;
        if (!init || init.round >= 3) break;
        apply({ kind: 'end_turn', entity: init.order[init.current]! });
      }
    },
  },
  {
    name: 'gatehouse-gm-tools',
    description:
      'All nine mutation tools through the same `executeGmTool` door the game master uses, with ' +
      'the three NPC templates loaded so `spawn` succeeds. This is the entry that holds the tool ' +
      'contract still: a renamed argument or a changed mapping fails it, which replay alone ' +
      'cannot see. It also proves the header carries the templates — without them the spawn, ' +
      'and every hash after it, does not replay.',
    objective: { type: 'QuestAdvanced', where: { quest: 'carry-the-scout', step: 1 } },
    snapshot: gatehouseSnapshot(),
    seed: GATEHOUSE_SEED,
    templates: GATEHOUSE_TEMPLATES,
    play({ tool }) {
      tool('say', {
        npc_id: GUARD_ID,
        text: 'State your business, and be quick about it.',
        to: PLAYER,
      });
      tool('set_disposition', {
        npc_id: GUARD_ID,
        toward: PLAYER,
        delta: 15,
        reason: 'the stranger came unarmed and said the scout was bleeding',
      });
      tool('set_flag', { key: 'gatehouse.watchword.burned', value: true });
      tool('advance_quest', { quest_id: 'carry-the-scout', step: 1 });
      tool('spawn', {
        template_id: 'guard',
        at: { x: 6, y: 1 },
        map: null,
        entity_id: 'gate-guard-relief',
      });
      tool('move', { entity_id: MERCHANT_ID, to: { x: 2, y: 8 } });
      // Three refusals the engine earned: a speaker who is not here, a quest walked backwards,
      // and a flag set to what it already is.
      tool('say', { npc_id: 'nobody', text: 'I am not here.', to: null });
      tool('advance_quest', { quest_id: 'carry-the-scout', step: 0 });
      tool('set_flag', { key: 'gatehouse.watchword.burned', value: true });
      // And the encounter, so `attack`, `cast` and `end_turn` are in the record too. Nobody in
      // the gatehouse knows a cantrip, so the cast is refused — which is the mapping under test.
      tool('attack', { attacker: MERCHANT_ID, target: PLAYER, ability: 'dagger' });
      tool('cast', { entity_id: MERCHANT_ID, spell: 'fire_bolt', target: PLAYER });
      tool('end_turn', { entity_id: MERCHANT_ID });
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Recording them
// ---------------------------------------------------------------------------------------------

function alive(snapshot: Snapshot, id: EntityId): boolean {
  const health = snapshot.entities[id]?.components.health;
  return !!health && health.hp > 0 && !health.conditions.includes('dead');
}

/** Plays one scenario and returns its recording plus the manifest row describing it. */
export function generateSession(scenario: Scenario): GeneratedSession {
  const sink = memorySink();
  const engine = createEngine(structuredClone(scenario.snapshot), {
    seed: scenario.seed,
    ...(scenario.templates ? { templates: scenario.templates } : {}),
  });
  const recorder = createRecorder(engine, {
    seed: scenario.seed,
    startedAt: STARTED_AT,
    sink,
    ...(scenario.templates ? { templates: scenario.templates } : {}),
  });

  /**
   * The engine as the GM sees it: `apply` commits and records the turn beside the call that asked
   * for it. This is `room.commitGmCall` with the broadcast removed — the same substitution, so
   * `executeGmTool` cannot tell it is not talking to the live server.
   */
  const gmEngine = (call: GmToolCall): Engine => ({
    snapshot: () => engine.snapshot(),
    hash: () => engine.hash(),
    apply: (intent) => {
      const hashBefore = engine.hash();
      const verdict = engine.apply(intent);
      recorder.record(intent, verdict, hashBefore, {
        toolCalls: [{ name: call.name, args: call.args, verdict }],
      });
      return verdict;
    },
  });

  scenario.play({
    engine,
    apply: (intent) => recorder.apply(intent),
    tool(name, args) {
      const call: GmToolCall = { name, args };
      const result = executeGmTool(gmEngine(call), call);
      return result.ok
        ? { ok: true, diff: result.diff }
        : { ok: false, reason: result.reason, diff: [] };
    },
  });
  recorder.close();

  const jsonl = sink.text();
  return {
    session: {
      name: scenario.name,
      file: `${scenario.name}.jsonl`,
      source: 'engine',
      description: scenario.description,
      objective: scenario.objective,
      expect: bankExpectation(parseRecording(jsonl), scenario.objective),
    },
    jsonl,
  };
}

/** Every generated entry, in manifest order. Pure: the same bytes on every machine, every run. */
export function generateBank(): GeneratedSession[] {
  return SCENARIOS.map(generateSession);
}
