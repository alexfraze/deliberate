import { describe, expect, it } from 'vitest';

import { createEngine } from '@deliberate/engine';
import {
  GATEHOUSE_SEED,
  GATEHOUSE_PLAYER_ID,
  GUARD_ID,
  MERCHANT_ID,
  NPC_ARCHETYPES,
  gatehouseSnapshot,
  npcEntity,
} from '@deliberate/npcs';
import { DEFAULT_ROOM, type Entity, type ServerMessage, type Snapshot } from '@deliberate/protocol';

import { createRoom, type RoomSocket } from '../room.js';
import { policyKey, stanceOf } from './cache.js';
import { createEngineRegistry } from './engines.js';
import { createGmLoop } from './loop.js';
import type { GmTurnRequest } from './service.js';
import { stubGmService, type PolicyScript, type ScriptedTurn } from './stub.js';
import { executeGmToolRequest } from './tool.js';

/**
 * ALE-37's evidence: **an NPC's later turns are taken by a policy, with no model call, and a
 * policy that stops working is retired rather than trusted.**
 *
 * As in ALE-22's tests, "after-GO time drops" is asserted as "asked the game master fewer times",
 * not as a wall-clock measurement — the seconds are a property of the machine, the model calls are
 * a property of the design. The real service runs the policy as Python in a sandbox; there is no
 * Python in `pnpm check`, so the stub plays that part with a function. Everything else in the path
 * is real: the tool contract, the `/gm/tool` door, the engine's validation, the room's commit.
 */

const TEMPLATES: Record<string, Entity> = Object.fromEntries(
  NPC_ARCHETYPES.map((npc) => [npc.archetype, npcEntity(npc)]),
);

/** Two NPCs and nobody else in the order, so initiative wraps and each acts twice in one GO. */
function brawling(): Snapshot {
  return {
    ...gatehouseSnapshot(),
    initiative: { order: [GUARD_ID, MERCHANT_ID], current: 0, round: 1 },
  };
}

function fakeSocket(): RoomSocket & { received: ServerMessage[] } {
  const received: ServerMessage[] = [];
  return {
    received,
    send(data) {
      received.push(JSON.parse(data) as ServerMessage);
    },
  };
}

interface HarnessOptions {
  script: (request: GmTurnRequest) => ScriptedTurn;
  policyScript?: PolicyScript;
  maxNpcTurns?: number;
}

/**
 * A real engine over a real scene with initiative running. The world moves on every `end_turn`, so
 * the state hash moves too — which is the point: the ALE-22 decision cache, keyed on that hash,
 * can never hit here. Anything that saves a model call in this harness is the skill cache.
 */
function harness(options: HarnessOptions) {
  const engine = createEngine(brawling(), { seed: GATEHOUSE_SEED, templates: TEMPLATES });
  const room = createRoom({ engine });
  const registry = createEngineRegistry({ engine, seed: GATEHOUSE_SEED, templates: TEMPLATES });
  const asked: GmTurnRequest[] = [];
  const ran: string[] = [];
  const deps = { registry, room };
  const gm = stubGmService({
    script: (request) => {
      asked.push(request);
      return options.script(request);
    },
    ...(options.policyScript
      ? {
          policyScript: ((code, acting) => {
            ran.push(`${acting}:${code}`);
            return options.policyScript!(code, acting);
          }) as PolicyScript,
        }
      : {}),
    call: (request) => executeGmToolRequest(deps, request),
  });
  const loop = createGmLoop({ room, registry, gm, maxNpcTurns: options.maxNpcTurns ?? 4 });
  room.setGmFrames((socket, message) => loop.handle(socket, message));

  const socket = fakeSocket();
  room.handle(socket, { type: 'join', room: DEFAULT_ROOM, protocol: 1 });
  socket.received.length = 0;

  const go = async (): Promise<void> => {
    // A turn with no player intent: the player passes and the NPCs act. That is the shape of the
    // turn the p95 tail lives in.
    room.handle(socket, { type: 'preview_request', room: DEFAULT_ROOM, turn: 0, intent: null });
    await loop.idle();
    room.handle(socket, { type: 'go', room: DEFAULT_ROOM, turn: 0 });
    await loop.idle();
  };

  const resolves = (): number => asked.filter((r) => r.phase === 'resolve').length;
  return { engine, room, loop, socket, asked, ran, go, resolves };
}

/** What the game master says on a resolve miss: it acts, and it writes down how. */
const writesAPolicy = (request: GmTurnRequest): ScriptedTurn => {
  if (request.phase !== 'resolve') return {};
  const acting = String((request.state as { acting?: string }).acting ?? '');
  return {
    calls: [{ tool: 'say', input: { npc_id: acting, text: 'Hold the line.', to: null } }],
    policy: { code: `hold:${acting}`, note: 'hold position and talk' },
  };
};

/** A policy that says a line and ends its own turn — the shape a real generated policy has. */
const holds: PolicyScript = (code, acting) =>
  code === `hold:${acting}`
    ? {
        calls: [
          { tool: 'say', input: { npc_id: acting, text: 'Still here.', to: null } },
          { tool: 'end_turn', input: { entity_id: acting } },
        ],
      }
    : { failed: `no policy called ${code}` };

describe('the skill cache', () => {
  it('takes an NPC later turns from its policy, without asking the model again', async () => {
    const h = harness({ script: writesAPolicy, policyScript: holds, maxNpcTurns: 4 });
    await h.go();

    // Four NPC turns: guard, merchant, guard, merchant. The first turn of each cost a model call
    // and bought a policy; the second of each was taken by that policy. Before ALE-37 this was
    // four model calls, in sequence, in the after-GO window.
    expect(h.resolves()).toBe(2);
    expect(h.ran).toEqual([`${GUARD_ID}:hold:${GUARD_ID}`, `${MERCHANT_ID}:hold:${MERCHANT_ID}`]);
    expect(h.loop.cache().policies).toMatchObject({ hits: 2, misses: 2, size: 2 });

    // And the policy turns were not free of consequence: the engine saw them, because every call
    // a policy makes goes through the same validated door the model's calls go through.
    const hash = h.engine.hash();
    expect(hash).not.toBe(createEngine(brawling(), { seed: GATEHOUSE_SEED }).hash());
  });

  it('retires a policy the engine refuses everything from, and asks the model instead', async () => {
    // The one call this policy makes names a speaker who is not in the world. The engine refuses
    // it — which is the whole safety story: a policy proposes, it does not mutate. Nothing landed,
    // so the turn was not taken, so the policy is thrown away rather than run again next turn.
    const h = harness({
      script: writesAPolicy,
      policyScript: () => ({
        calls: [{ tool: 'say', input: { npc_id: 'nobody-at-all', text: 'Hm.', to: null } }],
      }),
      maxNpcTurns: 4,
    });
    await h.go();

    expect(h.ran).toHaveLength(2);
    // Every one of the four NPC turns reached the model: two misses, and two turns where the
    // policy was tried, failed to land anything, and was retired in favour of asking.
    expect(h.resolves()).toBe(4);
    expect(h.loop.cache().policies).toMatchObject({ hits: 0, misses: 4 });
  });

  it('retires a policy whose program crashed or timed out', async () => {
    const h = harness({
      script: writesAPolicy,
      // What the sandbox returns for a snippet that raised, or that it killed for running long.
      policyScript: () => ({ failed: 'The python tool timed out after 2s.' }),
      maxNpcTurns: 4,
    });
    await h.go();

    expect(h.resolves()).toBe(4);
    expect(h.loop.cache().policies).toMatchObject({ hits: 0, misses: 4 });
  });

  it('falls back to the model when the policy service cannot be reached at all', async () => {
    // No `policyScript` at all: every run comes back `ok: false`. A GM service that is down, or
    // an older one with no `/policy` route, degrades to M1 behaviour — slow, and correct.
    const h = harness({ script: writesAPolicy, maxNpcTurns: 4 });
    await h.go();
    expect(h.resolves()).toBe(4);
  });

  it('does not cache a policy when caching is off', async () => {
    const engine = createEngine(brawling(), { seed: GATEHOUSE_SEED, templates: TEMPLATES });
    const room = createRoom({ engine });
    const registry = createEngineRegistry({ engine, seed: GATEHOUSE_SEED, templates: TEMPLATES });
    const asked: GmTurnRequest[] = [];
    const deps = { registry, room };
    const gm = stubGmService({
      script: (request) => {
        asked.push(request);
        return writesAPolicy(request);
      },
      policyScript: holds,
      call: (request) => executeGmToolRequest(deps, request),
    });
    const loop = createGmLoop({ room, registry, gm, maxNpcTurns: 4, cacheSize: 0 });
    room.setGmFrames((socket, message) => loop.handle(socket, message));
    const socket = fakeSocket();
    room.handle(socket, { type: 'join', room: DEFAULT_ROOM, protocol: 1 });
    room.handle(socket, { type: 'preview_request', room: DEFAULT_ROOM, turn: 0, intent: null });
    await loop.idle();
    room.handle(socket, { type: 'go', room: DEFAULT_ROOM, turn: 0 });
    await loop.idle();

    expect(asked.filter((r) => r.phase === 'resolve')).toHaveLength(4);
    expect(loop.cache().policies).toMatchObject({ hits: 0, misses: 0, size: 0 });
  });
});

describe('the policy key', () => {
  const snapshot = brawling();

  it('is per NPC, so two NPCs never share one program', () => {
    expect(policyKey(snapshot, GUARD_ID)).not.toBe(policyKey(snapshot, MERCHANT_ID));
  });

  it('ignores everything the policy re-reads each turn', () => {
    // Positions and hit points are what a policy branches on at run time, so moving a body or
    // wounding it is emphatically *not* "the situation changed". A key that noticed would
    // regenerate every turn and buy nothing.
    const moved = structuredClone(snapshot);
    const guard = moved.entities[GUARD_ID];
    if (guard?.components.position) guard.components.position.x += 1;
    if (guard?.components.health) guard.components.health.hp = 1;
    expect(policyKey(moved, GUARD_ID)).toBe(policyKey(snapshot, GUARD_ID));

    // Nor is whose turn it is next: a policy is written for an NPC, not for a slot in the order.
    const later = structuredClone(snapshot);
    if (later.initiative) later.initiative.current = 1;
    expect(policyKey(later, GUARD_ID)).toBe(policyKey(snapshot, GUARD_ID));
  });

  it('changes when the situation does', () => {
    const before = policyKey(snapshot, GUARD_ID);

    const peace = structuredClone(snapshot);
    peace.initiative = null;
    expect(policyKey(peace, GUARD_ID)).not.toBe(before);

    // The last member of a faction dying: there is nobody of that kind left to plan around.
    const bereft = structuredClone(snapshot);
    const merchant = bereft.entities[MERCHANT_ID];
    if (merchant?.components.health) merchant.components.health.conditions = ['dead'];
    expect(policyKey(bereft, GUARD_ID)).not.toBe(before);

    // And a guard who has turned on the player wants a different program, not the same one
    // applied harder.
    const angry = structuredClone(snapshot);
    const guard = angry.entities[GUARD_ID];
    if (guard?.components.disposition)
      guard.components.disposition.toward[GATEHOUSE_PLAYER_ID] = -80;
    expect(policyKey(angry, GUARD_ID)).not.toBe(before);
  });

  it('bands disposition where the content already bands it', () => {
    // `content/npcs` gates its dialogue at -20 and 25; reusing those thresholds keeps "the
    // situation changed" meaning the same thing to the cache as it does to the writing.
    expect(stanceOf(-100)).toBe('hostile');
    expect(stanceOf(-21)).toBe('hostile');
    expect(stanceOf(-20)).toBe('wary');
    expect(stanceOf(0)).toBe('wary');
    expect(stanceOf(24)).toBe('wary');
    expect(stanceOf(25)).toBe('warm');
  });
});
