import { describe, expect, it } from 'vitest';

import { createEngine } from '@deliberate/engine';
import {
  GATEHOUSE_PLAYER_ID,
  GATEHOUSE_SEED,
  GUARD_ID,
  MERCHANT_ID,
  NPC_ARCHETYPES,
  SCOUT_ID,
  gatehouseSnapshot,
  npcEntity,
} from '@deliberate/npcs';
import {
  DEFAULT_ROOM,
  type Entity,
  type Intent,
  type ServerMessage,
  type Snapshot,
} from '@deliberate/protocol';

import { createRoom, type RoomSocket } from '../room.js';
import { ambientCandidates, senseOf, type AmbientSense } from './ambient.js';
import { createEngineRegistry } from './engines.js';
import { createGmLoop } from './loop.js';
import type { GmTurnRequest } from './service.js';
import { stubGmService, type PolicyScript, type ScriptedTurn } from './stub.js';
import { executeGmToolRequest } from './tool.js';

/**
 * ALE-41's evidence: **a player who never attacks still sees the world act, and a world with
 * nothing to say still costs nothing.**
 *
 * The two halves are asserted the way ALE-22 and ALE-37 assert theirs — in model calls, not in
 * seconds, because the seconds are a property of the machine and the calls are a property of the
 * design. Everything else in the path is real: the engine, the `/gm/tool` door, the validation,
 * the room's commit. What the stub stands in for is the model's judgement.
 */

const TEMPLATES: Record<string, Entity> = Object.fromEntries(
  NPC_ARCHETYPES.map((npc) => [npc.archetype, npcEntity(npc)]),
);

const WAIT: Intent = { kind: 'pass_time', entity: GATEHOUSE_PLAYER_ID };

function fakeSocket(): RoomSocket & { received: ServerMessage[] } {
  const received: ServerMessage[] = [];
  return {
    received,
    send(data) {
      received.push(JSON.parse(data) as ServerMessage);
    },
  };
}

/** Puts the player on a given tile, so a test can say "they walked up to the gate" in one line. */
function standing(at: { x: number; y: number }): Snapshot {
  const snapshot = gatehouseSnapshot();
  const position = snapshot.entities[GATEHOUSE_PLAYER_ID]!.components.position!;
  position.x = at.x;
  position.y = at.y;
  return snapshot;
}

interface HarnessOptions {
  snapshot?: Snapshot;
  script?: (request: GmTurnRequest) => ScriptedTurn;
  policyScript?: PolicyScript;
  ambient?: { noticeFt?: number; idleRounds?: number; max?: number };
}

/** A real engine over the real gatehouse scene, with **no encounter running**. */
function harness(options: HarnessOptions = {}) {
  const engine = createEngine(options.snapshot ?? gatehouseSnapshot(), {
    seed: GATEHOUSE_SEED,
    templates: TEMPLATES,
  });
  const room = createRoom({ engine });
  const registry = createEngineRegistry({ engine, seed: GATEHOUSE_SEED, templates: TEMPLATES });
  const asked: GmTurnRequest[] = [];
  const deps = { registry, room };
  const gm = stubGmService({
    script: (request) => {
      asked.push(request);
      return options.script ? options.script(request) : {};
    },
    ...(options.policyScript ? { policyScript: options.policyScript } : {}),
    call: (request) => executeGmToolRequest(deps, request),
  });
  const loop = createGmLoop({
    room,
    registry,
    gm,
    ...(options.ambient ? { ambient: options.ambient } : {}),
  });
  room.setGmFrames((socket, message) => loop.handle(socket, message));

  const socket = fakeSocket();
  room.handle(socket, { type: 'join', room: DEFAULT_ROOM, protocol: 1 });
  socket.received.length = 0;

  /** One whole player turn: preview, then GO. The ambient turn happens inside the GO. */
  const play = async (intent: Intent | null): Promise<void> => {
    room.handle(socket, {
      type: 'preview_request',
      room: DEFAULT_ROOM,
      turn: room.turn(),
      intent,
    });
    await loop.idle();
    room.handle(socket, { type: 'go', room: DEFAULT_ROOM, turn: room.turn() });
    await loop.idle();
  };

  const phases = (phase: string): GmTurnRequest[] => asked.filter((r) => r.phase === phase);
  const actors = (): string[] =>
    phases('ambient').map((r) => String((r.state as { acting?: string }).acting ?? ''));
  return { engine, room, loop, socket, asked, play, phases, actors };
}

/** A game master that has whoever is acting say one line. The smallest visible ambient act. */
const speaks = (request: GmTurnRequest): ScriptedTurn => {
  if (request.phase !== 'ambient') return {};
  const acting = String((request.state as { acting?: string }).acting ?? '');
  return {
    calls: [{ tool: 'say', input: { npc_id: acting, text: 'Mind yourself.', to: null } }],
    narration: 'A voice crosses the yard.',
  };
};

describe('pass_time, the player verb', () => {
  it('is legal outside an encounter and moves the clock, and nothing else', async () => {
    const engine = createEngine(gatehouseSnapshot(), { seed: GATEHOUSE_SEED });
    const before = engine.snapshot();
    const verdict = engine.apply(WAIT);

    expect(verdict.ok).toBe(true);
    expect(verdict.diff).toEqual([{ type: 'TurnAdvanced', initiative: null, clock: 1 }]);
    const after = engine.snapshot();
    expect(after.world.clock).toBe(before.world.clock + 1);
    // No initiative was started, nobody moved, and no economy was spent: waiting is not a turn in
    // a fight, it is a minute of the world's time.
    expect(after.initiative).toBeNull();
    expect(after.entities).toEqual(before.entities);
  });

  it('is refused inside an encounter, which is where end_turn lives', () => {
    const engine = createEngine(
      {
        ...gatehouseSnapshot(),
        initiative: { order: [GATEHOUSE_PLAYER_ID, GUARD_ID], current: 0, round: 1 },
      },
      { seed: GATEHOUSE_SEED },
    );
    const verdict = engine.apply(WAIT);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('end their turn instead');
    expect(verdict.diff).toEqual([]);
  });

  /**
   * The trap this feature had to avoid, asserted rather than trusted. Four turns in the regression
   * bank are recordings of this exact refusal — one in `gatehouse-refusals`, three in
   * `injection-bank` — so `pass_time` had to be a new verb rather than a new meaning for an old
   * one. If someone later "simplifies" this by making `end_turn` legal out of combat, this fails
   * before `pnpm bank` has to.
   */
  it('leaves end_turn outside an encounter refused for exactly the reason the bank recorded', () => {
    const engine = createEngine(gatehouseSnapshot(), { seed: GATEHOUSE_SEED });
    const verdict = engine.apply({ kind: 'end_turn', entity: GATEHOUSE_PLAYER_ID });
    expect(verdict).toEqual({
      ok: false,
      reason: 'No encounter is running; there is no turn to end.',
      diff: [],
    });
  });

  it('refuses a corpse the dignity of waiting', () => {
    const snapshot = gatehouseSnapshot();
    snapshot.entities[GATEHOUSE_PLAYER_ID]!.components.health = {
      hp: 0,
      maxHp: 12,
      conditions: ['dead'],
    };
    const engine = createEngine(snapshot, { seed: GATEHOUSE_SEED });
    const verdict = engine.apply(WAIT);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('dead');
  });
});

describe('who stirs, and why', () => {
  const sensed = (npc: string, snapshot: Snapshot): AmbientSense =>
    senseOf(snapshot, npc, GATEHOUSE_PLAYER_ID);

  it('says nobody when nothing anyone can perceive has changed', () => {
    const snapshot = gatehouseSnapshot();
    const acted = new Map(
      [GUARD_ID, MERCHANT_ID, SCOUT_ID].map((id) => [id, sensed(id, snapshot)]),
    );
    expect(ambientCandidates(snapshot, acted)).toEqual([]);
  });

  it('wakes an NPC the player has just walked up to, and names the reason', () => {
    const before = gatehouseSnapshot();
    const acted = new Map([GUARD_ID, MERCHANT_ID, SCOUT_ID].map((id) => [id, sensed(id, before)]));
    // Brannoc lies at (10, 9); the player starts at (2, 9), forty feet off. Walk over to him.
    const after = standing({ x: 9, y: 9 });
    const candidates = ambientCandidates(after, acted);

    expect(candidates.map((c) => c.entity)).toEqual([SCOUT_ID]);
    expect(candidates[0]!.reason).toContain('the player has come close enough to touch');
  });

  it('takes the nearest first and leaves the rest queued rather than cancelled', () => {
    // Nobody has acted yet, so all three have something to say; only one of them gets to.
    const snapshot = gatehouseSnapshot();
    const first = ambientCandidates(snapshot, new Map());
    expect(first).toHaveLength(1);
    // Ilva stands at (3, 6), fifteen feet from the player; Halloran is twenty-five feet off.
    expect(first[0]!.entity).toBe(MERCHANT_ID);

    const acted = new Map([[MERCHANT_ID, first[0]!.sense]]);
    expect(ambientCandidates(snapshot, acted).map((c) => c.entity)).toEqual([GUARD_ID]);
  });

  it('notices a quest step and a change of heart, not only footsteps', () => {
    const snapshot = gatehouseSnapshot();
    const acted = new Map(
      [GUARD_ID, MERCHANT_ID, SCOUT_ID].map((id) => [id, sensed(id, snapshot)]),
    );

    const questMoved = structuredClone(snapshot);
    questMoved.world.quests['carry-the-scout']!.step = 1;
    // Everyone hears it; the nearest is the one who answers.
    expect(ambientCandidates(questMoved, acted).map((c) => c.reason)).toEqual([
      'a quest has moved a step',
    ]);

    const warmed = structuredClone(snapshot);
    warmed.entities[GUARD_ID]!.components.disposition!.toward[GATEHOUSE_PLAYER_ID] = 60;
    expect(ambientCandidates(warmed, acted)[0]!.reason).toContain('now warm');
  });

  it('lets time itself be the reason, slowly', () => {
    const snapshot = gatehouseSnapshot();
    const acted = new Map(
      [GUARD_ID, MERCHANT_ID, SCOUT_ID].map((id) => [id, sensed(id, snapshot)]),
    );
    // Two waits are not news. Three are: the player has been standing there.
    const waited = (rounds: number): Snapshot => ({
      ...structuredClone(snapshot),
      world: { ...structuredClone(snapshot.world), clock: rounds },
    });
    expect(ambientCandidates(waited(2), acted)).toEqual([]);
    expect(ambientCandidates(waited(3), acted)[0]!.reason).toContain('time has passed');
  });

  it('says nobody at all while initiative is running — that is initiative’s question', () => {
    const snapshot = {
      ...gatehouseSnapshot(),
      initiative: { order: [GATEHOUSE_PLAYER_ID, GUARD_ID], current: 0, round: 1 },
    };
    expect(ambientCandidates(snapshot, new Map())).toEqual([]);
  });

  it('skips the dead and the unconscious rather than paying to have them refused', () => {
    const snapshot = gatehouseSnapshot();
    snapshot.entities[MERCHANT_ID]!.components.health!.conditions = ['dead'];
    expect(ambientCandidates(snapshot, new Map())[0]!.entity).toBe(GUARD_ID);
  });
});

describe('the ambient world turn', () => {
  it('lets an NPC act on a turn in which the player only waited', async () => {
    const h = harness({ script: speaks });
    await h.play(WAIT);

    expect(h.actors()).toEqual([MERCHANT_ID]);
    const lines = h.socket.received.filter(
      (m) => m.type === 'diffs' && m.diffs.some((d) => d.type === 'DialogueLine'),
    );
    expect(lines).not.toHaveLength(0);
  });

  it('costs nothing at all when the world has nothing to react to', async () => {
    // The slow idle drum is turned right down, so the only thing left to react to is the player —
    // which is what this test is about. `lets time itself be the reason` covers the drum.
    const h = harness({ script: speaks, ambient: { idleRounds: 10_000 } });
    // Three waits. The first wakes Ilva, the second Halloran, the third Brannoc — and then every
    // NPC has reacted to this reading of the world and the yard goes quiet.
    await h.play(WAIT);
    await h.play(WAIT);
    await h.play(WAIT);
    expect(h.actors()).toEqual([MERCHANT_ID, GUARD_ID, SCOUT_ID]);

    const spentSoFar = h.asked.length;
    await h.play(WAIT);

    // No preview call (waiting has nothing to telegraph), no ambient turn (nothing changed) and
    // no narration (nothing happened). A quiet minute is free.
    expect(h.asked).toHaveLength(spentSoFar);
  });

  it('does not pay a model call to preview a wait', async () => {
    const h = harness({ script: speaks });
    await h.play(WAIT);
    expect(h.phases('preview')).toEqual([]);
    // And an ordinary intent still previews as it always did.
    await h.play({ kind: 'move', entity: GATEHOUSE_PLAYER_ID, to: { x: 3, y: 9 } });
    expect(h.phases('preview')).toHaveLength(1);
  });

  it('runs after an ordinary turn too, so walking up to someone is itself a cue', async () => {
    // Everyone has already reacted to where the player was standing.
    const h = harness({ script: speaks });
    await h.play(WAIT);
    await h.play(WAIT);
    await h.play(WAIT);
    const before = h.actors().length;

    // Now cross the yard toward Brannoc. He is the one who should look up.
    await h.play({ kind: 'move', entity: GATEHOUSE_PLAYER_ID, to: { x: 5, y: 9 } });
    await h.play({ kind: 'move', entity: GATEHOUSE_PLAYER_ID, to: { x: 8, y: 9 } });
    expect(h.actors().slice(before)).toContain(SCOUT_ID);
  });

  it('tells the game master what the NPC noticed', async () => {
    const h = harness({ script: speaks });
    await h.play(WAIT);
    const cue = (h.phases('ambient')[0]!.state as { cue?: string }).cue;
    expect(cue).toBe('they have not yet stirred since the player arrived');
  });

  /**
   * ALE-37's missing caller, as a test. The first ambient turn an NPC takes asks the model and
   * asks it to write the habit down; every one after that is the 33 ms path, with no model call.
   */
  it('takes an NPC’s later idle turns from its policy, with no model call', async () => {
    // Ilva alone in the yard, so the same person comes round every turn, and the drum beats every
    // round so she always has something to answer.
    const alone = gatehouseSnapshot();
    delete alone.entities[GUARD_ID];
    delete alone.entities[SCOUT_ID];
    const h = harness({
      snapshot: alone,
      script: (request) => {
        if (request.phase !== 'ambient') return {};
        const acting = String((request.state as { acting?: string }).acting ?? '');
        const turn = speaks(request);
        // The loop asks for a policy on the *first* ambient sighting: idling repeats by
        // construction, so there is nothing to wait for a second sighting to prove.
        expect(request.want_policy).toBe(true);
        return { ...turn, policy: { code: `idle:${acting}`, note: 'watch and wait' } };
      },
      policyScript: (code, acting) =>
        code === `idle:${acting}`
          ? { calls: [{ tool: 'say', input: { npc_id: acting, text: 'Still here.', to: null } }] }
          : { failed: `no policy called ${code}` },
      ambient: { idleRounds: 1 },
    });

    await h.play(WAIT);
    await h.play(WAIT);
    await h.play(WAIT);
    await h.play(WAIT);

    // Four ambient turns, and the model was asked for exactly one of them: the first. The other
    // three are ALE-37's path — the program the game master wrote, run with no model in the loop.
    expect(h.loop.ambient().npcTurns).toBe(4);
    expect(h.phases('ambient')).toHaveLength(1);
    expect(h.loop.ambient().fromPolicy).toBe(3);
    expect(h.loop.cache().policies.hits).toBe(3);
  });

  it('is off when asked to be, without a protocol change', async () => {
    const h = harness({ script: speaks, ambient: { max: 0 } });
    await h.play(WAIT);
    expect(h.asked).toEqual([]);
    expect(h.loop.ambient()).toMatchObject({ turns: 1, npcTurns: 0 });
  });

  /**
   * The one thing other than a player that may open an encounter, and it needed no new code: the
   * engine starts initiative on the first attack whoever throws it, so a guard who has had enough
   * opens the fight himself and `resolve` picks it up on the same GO.
   */
  it('lets a provoked NPC start the fight, and hands it to initiative', async () => {
    const h = harness({
      // The player is standing on Halloran's toes at the gate.
      snapshot: standing({ x: 6, y: 5 }),
      script: (request) => {
        if (request.phase !== 'ambient') return {};
        return {
          calls: [
            {
              tool: 'attack',
              input: { attacker: GUARD_ID, target: GATEHOUSE_PLAYER_ID, ability: 'longsword' },
            },
          ],
        };
      },
      ambient: { noticeFt: 5 },
    });
    expect(h.engine.snapshot().initiative).toBeNull();

    await h.play(WAIT);

    expect(h.actors()).toEqual([GUARD_ID]);
    // Initiative is running, and the ambient turn did not start it — `applyAttack` did.
    expect(h.engine.snapshot().initiative).not.toBeNull();
  });
});
