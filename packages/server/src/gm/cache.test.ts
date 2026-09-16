import { describe, expect, it, vi } from 'vitest';

import { createEngine, type Engine } from '@deliberate/engine';
import {
  GATEHOUSE_SEED,
  GATEHOUSE_PLAYER_ID,
  GUARD_ID,
  NPC_ARCHETYPES,
  gatehouseSnapshot,
  npcEntity,
} from '@deliberate/npcs';
import {
  DEFAULT_ROOM,
  type Entity,
  type Intent,
  type PreviewMessage,
  type ServerMessage,
  type Snapshot,
} from '@deliberate/protocol';

import { createRoom, type RoomSocket } from '../room.js';
import { createTurnCache, decisionKey, previewKey } from './cache.js';
import { createEngineRegistry } from './engines.js';
import { createGmLoop, type GmLoopOptions } from './loop.js';
import type { GmTurnRequest, GmTurnResponse } from './service.js';
import { stubGmService, type ScriptedTurn } from './stub.js';
import { executeGmToolRequest } from './tool.js';

/**
 * ALE-22's evidence: **a repeated preview of the same intent returns without asking the game
 * master, and any state change invalidates it.**
 *
 * "Returns in 0 s" is asserted as "asked the game master zero times", not as a wall-clock
 * measurement. A test that watched the clock would measure the machine it ran on; what the cache
 * actually promises is that the expensive thing — the model call behind the HTTP hop — does not
 * happen twice for the same question. The stub GM records every `/turn` it is asked for, so the
 * count is exact, and the seconds follow from it.
 */

const TEMPLATES: Record<string, Entity> = Object.fromEntries(
  NPC_ARCHETYPES.map((npc) => [npc.archetype, npcEntity(npc)]),
);

function fakeSocket(): RoomSocket & { received: ServerMessage[] } {
  const received: ServerMessage[] = [];
  return {
    received,
    send(data) {
      received.push(JSON.parse(data) as ServerMessage);
    },
  };
}

type Script = (request: GmTurnRequest) => ScriptedTurn;

function harness(script: Script, options: Partial<GmLoopOptions> = {}) {
  const engine = createEngine(gatehouseSnapshot(), { seed: GATEHOUSE_SEED, templates: TEMPLATES });
  const room = createRoom({ engine });
  const registry = createEngineRegistry({ engine, seed: GATEHOUSE_SEED, templates: TEMPLATES });
  const asked: GmTurnRequest[] = [];
  const deps = { registry, room };
  const gm = stubGmService({
    script: (request) => {
      asked.push(request);
      return script(request);
    },
    call: (request) => executeGmToolRequest(deps, request),
  });
  const loop = createGmLoop({ room, registry, gm, ...options });
  room.setGmFrames((socket, message) => loop.handle(socket, message));

  const socket = fakeSocket();
  room.handle(socket, { type: 'join', room: DEFAULT_ROOM, protocol: 1 });
  socket.received.length = 0;

  const preview = async (intent: Intent | null, text?: string): Promise<void> => {
    room.handle(socket, {
      type: 'preview_request',
      room: DEFAULT_ROOM,
      turn: room.turn(),
      intent,
      ...(text === undefined ? {} : { text }),
    });
    await loop.idle();
  };
  const go = async (): Promise<void> => {
    room.handle(socket, { type: 'go', room: DEFAULT_ROOM, turn: room.turn() });
    await loop.idle();
  };

  return { engine, room, registry, loop, socket, asked, preview, go };
}

/** The player takes one step east. Legal from the gatehouse start, and it moves the state hash. */
function step(dx: number): Intent {
  const start = gatehouseSnapshot().entities[GATEHOUSE_PLAYER_ID]?.components.position;
  return {
    kind: 'move',
    entity: GATEHOUSE_PLAYER_ID,
    to: { x: (start?.x ?? 0) + dx, y: start?.y ?? 0 },
  };
}

const previews = (socket: { received: ServerMessage[] }): PreviewMessage[] =>
  socket.received.filter((m): m is PreviewMessage => m.type === 'preview');

describe('the preview cache', () => {
  it('answers a repeated preview of the same intent without asking the game master', async () => {
    const h = harness(() => ({ narration: 'Halloran shifts his weight.' }));

    await h.preview(step(1));
    expect(h.asked).toHaveLength(1);
    expect(h.loop.cache().preview).toMatchObject({ hits: 0, misses: 1, size: 1 });

    await h.preview(step(1));
    // Zero seconds, stated as the thing that actually takes the seconds: no second model call.
    expect(h.asked).toHaveLength(1);
    expect(h.loop.cache().preview).toMatchObject({ hits: 1, misses: 1 });

    // And the player sees the same preview, not an empty one.
    const shown = previews(h.socket);
    expect(shown).toHaveLength(2);
    expect(shown[1]?.text).toBe(shown[0]?.text);
    expect(shown[1]?.diffs).toEqual(shown[0]?.diffs);
  });

  it('misses on a different intent, and on the same intent with different player text', async () => {
    const h = harness(() => ({ narration: 'The yard waits.' }));

    await h.preview(step(1));
    await h.preview(step(-1));
    expect(h.asked).toHaveLength(2);

    // Same intent, different words: the same question to the engine and a different one to the
    // game master. Conflating them would answer the second with the first's narration.
    const say: Intent = { kind: 'say', speaker: GATEHOUSE_PLAYER_ID, text: 'Hail.', to: GUARD_ID };
    await h.preview(say, 'I am friendly.');
    await h.preview(say, 'I am armed.');
    expect(h.asked).toHaveLength(4);
    await h.preview(say, 'I am armed.');
    expect(h.asked).toHaveLength(4);
  });

  it('invalidates on any state change, because the state hash is the key', async () => {
    const h = harness(() => ({ narration: 'A pause.' }));
    // Speech, so the same intent stays legal on both sides of the state change and the only thing
    // that differs between the two asks is the world.
    const hail: Intent = { kind: 'say', speaker: GATEHOUSE_PLAYER_ID, text: 'Hail.', to: GUARD_ID };

    await h.preview(hail);
    await h.preview(hail);
    expect(h.asked).toHaveLength(1);
    const before = h.engine.hash();

    // Somebody moved. A different world is a different key, therefore a miss — with no
    // invalidation pass anywhere in the code that could have been forgotten to run.
    expect(h.room.commit(step(1)).ok).toBe(true);
    expect(h.engine.hash()).not.toBe(before);

    await h.preview(hail);
    expect(h.asked).toHaveLength(2);
    expect(h.loop.cache().preview).toMatchObject({ hits: 1, misses: 2, size: 2 });
  });

  it('does not cache a preview the game master failed to answer', async () => {
    let fail = true;
    const h = harness(() => {
      if (fail) throw new Error('the game master fell over');
      return { narration: 'Halloran nods.' };
    });

    await h.preview(step(1));
    expect(previews(h.socket)).toHaveLength(1);
    expect(h.loop.cache().preview.size).toBe(0);

    // A timeout is a fact about one moment. The next ask gets a real answer rather than the blip.
    fail = false;
    await h.preview(step(1));
    expect(h.loop.cache().preview.size).toBe(1);
    expect(previews(h.socket)[1]?.text).toBe('Halloran nods.');
  });

  it('does not cache an intent the engine refused, and refuses it again', async () => {
    const h = harness(() => ({ narration: 'unreachable' }));
    // Off the map: the clone refuses it before the game master is ever asked.
    await h.preview({ kind: 'move', entity: GATEHOUSE_PLAYER_ID, to: { x: -5, y: -5 } });
    expect(h.socket.received.at(-1)?.type).toBe('error');
    expect(h.asked).toHaveLength(0);
    expect(h.loop.cache().preview.size).toBe(0);
    expect(h.loop.pending()).toBeNull();
  });

  it('still commits through the real engine on GO, and preview never mutates it', async () => {
    // The danger the cache introduces is a stale telegraph looking authoritative. It cannot: GO
    // re-validates every call against the real engine, cached or not, and preview runs on a clone.
    const h = harness(() => ({
      calls: [{ tool: 'say', input: { npc_id: GUARD_ID, text: 'Halt.', to: null } }],
      narration: 'Halloran raises a hand.',
    }));

    const before = h.engine.hash();
    await h.preview(step(1));
    await h.preview(step(1));
    expect(h.engine.hash(), 'a cached preview mutated the real engine').toBe(before);
    expect(h.asked).toHaveLength(1);

    await h.go();
    expect(h.engine.hash()).not.toBe(before);
    expect(h.room.turn()).toBe(1);
  });

  it('is off when the size is zero', async () => {
    const h = harness(() => ({ narration: 'A pause.' }), { cacheSize: 0 });
    await h.preview(step(1));
    await h.preview(step(1));
    expect(h.asked).toHaveLength(2);
    expect(h.loop.cache().preview.size).toBe(0);
  });
});

describe('speculation', () => {
  it('warms the cache while the player deliberates, so their preview is already waiting', async () => {
    const h = harness(() => ({ narration: 'The gate creaks.' }));

    await h.loop.speculate([step(1), step(-1)]);
    expect(h.asked).toHaveLength(2);
    // Nothing was shown and nothing was staged: speculation only fills a cache.
    expect(h.socket.received).toHaveLength(0);
    expect(h.loop.pending()).toBeNull();

    await h.preview(step(1));
    expect(h.asked).toHaveLength(2);
    expect(previews(h.socket)).toHaveLength(1);
    expect(h.loop.pending()?.text).toBe('The gate creaks.');
  });

  it('yields to a real preview instead of refusing it', async () => {
    const h = harness(() => ({ narration: 'The gate creaks.' }));
    // Five intents queued; the player asks for one immediately. The player is served, and the
    // speculation that had not started yet is dropped rather than making them wait for it.
    const warming = h.loop.speculate([step(1), step(-1), step(2), step(-2), step(3)]);
    await h.preview(step(1));
    await warming;
    expect(h.socket.received.at(-1)?.type).toBe('preview');
    expect(h.asked.length).toBeLessThan(6);
  });
});

/**
 * A world that never moves. Real play almost never revisits a state hash — every `end_turn` moves
 * initiative on — so an NPC turn taken twice from the identical world is staged here with a fake
 * engine, which is the seam `Engine` exists for ("code against the interface and test with a
 * fake"). Everything else in the path is real: the tool contract, `/gm/tool`, the room's commit.
 */
function frozenEngine(snapshot: Snapshot): Engine & { applied: Intent[] } {
  const applied: Intent[] = [];
  return {
    applied,
    snapshot: () => structuredClone(snapshot),
    hash: () => 'frozen',
    rngCalls: () => 0,
    apply(intent) {
      applied.push(intent);
      return { ok: true, diff: [] };
    },
  };
}

describe('the NPC decision cache', () => {
  it('replays a cached decision through the engine rather than asking the model again', async () => {
    const snapshot: Snapshot = {
      ...gatehouseSnapshot(),
      initiative: { order: [GUARD_ID, GATEHOUSE_PLAYER_ID], current: 0, round: 1 },
    };
    const engine = frozenEngine(snapshot);
    const room = createRoom({ engine });
    const registry = createEngineRegistry({
      engine,
      seed: GATEHOUSE_SEED,
      createEngine: () => engine,
    });
    const asked: GmTurnRequest[] = [];
    const deps = { registry, room };
    const gm = stubGmService({
      script: (request) => {
        asked.push(request);
        return request.phase === 'resolve'
          ? { calls: [{ tool: 'say', input: { npc_id: GUARD_ID, text: 'Hold.', to: null } }] }
          : {};
      },
      call: (request) => executeGmToolRequest(deps, request),
    });
    const loop = createGmLoop({ room, registry, gm, maxNpcTurns: 3 });
    room.setGmFrames((socket, message) => loop.handle(socket, message));

    const socket = fakeSocket();
    room.handle(socket, { type: 'join', room: DEFAULT_ROOM, protocol: 1 });
    room.handle(socket, {
      type: 'preview_request',
      room: DEFAULT_ROOM,
      turn: 0,
      intent: null,
    });
    await loop.idle();
    room.handle(socket, { type: 'go', room: DEFAULT_ROOM, turn: 0 });
    await loop.idle();

    // Three NPC turns from the same world: the game master decided once.
    expect(asked.filter((r) => r.phase === 'resolve')).toHaveLength(1);
    expect(loop.cache().decisions).toMatchObject({ hits: 2, misses: 1, size: 1 });

    // And the two cached turns were not free of consequence: each replayed its plan through the
    // engine, so the world still saw three `say` intents and three forced `end_turn`s. The cache
    // remembers what the NPC decided to try, never what the world let it do.
    expect(engine.applied.filter((i) => i.kind === 'say')).toHaveLength(3);
    expect(engine.applied.filter((i) => i.kind === 'end_turn')).toHaveLength(3);
  });

  it('keys an NPC turn on the world and on whose turn it is', () => {
    expect(decisionKey('h', GUARD_ID)).not.toBe(decisionKey('h', GATEHOUSE_PLAYER_ID));
    expect(decisionKey('h', GUARD_ID)).not.toBe(decisionKey('h2', GUARD_ID));
  });
});

describe('the cache itself', () => {
  it('evicts the least recently used entry', () => {
    const cache = createTurnCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // 'a' is now the most recently used
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.stats().size).toBe(2);
  });

  it('hands out copies, so a caller cannot edit what the next one reads', () => {
    const cache = createTurnCache<{ calls: string[] }>();
    cache.set('k', { calls: ['say'] });
    const first = cache.get('k');
    first?.calls.push('attack');
    expect(cache.get('k')?.calls).toEqual(['say']);
  });

  it('keys on the canonical intent, so key order in the object cannot matter', () => {
    const hash = 'h';
    const a: Intent = { kind: 'move', entity: 'player', to: { x: 1, y: 2 } };
    const b = { to: { y: 2, x: 1 }, entity: 'player', kind: 'move' } as unknown as Intent;
    expect(previewKey(hash, a, null)).toBe(previewKey(hash, b, null));
    expect(previewKey(hash, a, null)).not.toBe(previewKey(hash, a, 'words'));
    expect(previewKey(hash, a, null)).not.toBe(previewKey('h2', a, null));
    expect(previewKey(hash, null, null)).not.toBe(previewKey(hash, a, null));
  });
});

/**
 * ALE-40: the client-side chooser, and the server-side ceiling that does not trust it.
 *
 * ALE-22 built `speculate()` and nothing called it, so the cache measured zero hits in every live
 * run. These are the tests for the wire that now does — and, because every speculation is a real
 * model call, most of them assert a call that must **not** happen.
 */
describe('speculative warming over the wire', () => {
  const hover = async (
    h: ReturnType<typeof harness>,
    intent: Intent,
    turn = h.room.turn(),
  ): Promise<void> => {
    h.room.handle(h.socket, { type: 'speculate', room: DEFAULT_ROOM, turn, intent });
    await h.loop.idle();
  };

  it('warms the preview the hovering player then asks for, and answers it without a model call', async () => {
    const h = harness(() => ({ narration: 'The gate creaks.' }));

    await hover(h, step(1));
    expect(h.asked, 'hovering did not warm anything').toHaveLength(1);
    // A hint, not a request: nothing came back down the socket and nothing is staged.
    expect(h.socket.received).toHaveLength(0);
    expect(h.loop.pending()).toBeNull();

    await h.preview(step(1));
    expect(h.asked, 'the warmed answer was not reused').toHaveLength(1);
    expect(h.loop.cache().preview).toMatchObject({ hits: 1 });
    expect(previews(h.socket).at(-1)?.text).toBe('The gate creaks.');
  });

  it('never mutates the real engine, even when the game master acts during one', async () => {
    const h = harness(() => ({
      calls: [
        { tool: 'say', input: { npc_id: GUARD_ID, text: 'Halt.', to: null } },
        { tool: 'set_flag', input: { key: 'warned', value: true } },
      ],
      narration: 'Halloran raises a hand.',
    }));

    const before = h.engine.hash();
    await hover(h, step(1));
    expect(h.asked).toHaveLength(1);
    expect(h.engine.hash(), 'speculation mutated the real world').toBe(before);
    expect(h.room.turn()).toBe(0);
  });

  it('spends no more than the turn allowance however much the pointer wanders', async () => {
    const h = harness(() => ({ narration: 'A pause.' }));
    for (const dx of [1, -1, 2, -2, 3]) await hover(h, step(dx));

    expect(h.asked, 'the pointer spent more than its allowance').toHaveLength(2);
    expect(h.loop.speculation()).toMatchObject({ turn: 0, spent: 2, dropped: 3, budget: 2 });
    // The stub reports no usage, so the dollar ceiling never bit here: this was the count cap.
    expect(h.loop.speculation().usd).toBe(0);

    // Committing moves the world on, so every cached key dies and the allowance starts again.
    await h.preview(step(1));
    await h.go();
    await hover(h, step(2));
    expect(h.loop.speculation()).toMatchObject({ turn: 1, spent: 1, dropped: 0 });
  });

  it('is off entirely when the budget is zero', async () => {
    const h = harness(() => ({ narration: 'A pause.' }), { speculationsPerTurn: 0 });
    await hover(h, step(1));
    expect(h.asked).toHaveLength(0);
    expect(h.loop.speculation()).toMatchObject({ spent: 0, dropped: 1, budget: 0 });
    // And the player's own preview still works: the kill switch kills the guessing, not the game.
    await h.preview(step(1));
    expect(h.asked).toHaveLength(1);
  });

  it('drops a speculation composed against a turn that has already moved on', async () => {
    const h = harness(() => ({ narration: 'A pause.' }));
    await h.preview(step(1));
    await h.go();
    const before = h.asked.length;
    await hover(h, step(2), 0);
    expect(h.asked.length, 'a stale speculation reached the game master').toBe(before);
    // Silently: the player did not ask for anything, so there is nothing to refuse them.
    expect(h.socket.received.filter((m) => m.type === 'error')).toHaveLength(0);
  });

  it('charges nothing for hovering over ground the engine refuses', async () => {
    const h = harness(() => ({ narration: 'unreachable' }));
    await hover(h, { kind: 'move', entity: GATEHOUSE_PLAYER_ID, to: { x: -5, y: -5 } });
    expect(h.asked).toHaveLength(0);
    expect(h.loop.speculation()).toMatchObject({ spent: 0 });
  });

  it('bounds the speculative spend it reports on the turn it was spent in', async () => {
    const h = harness(() => ({ narration: 'A pause.' }));
    await hover(h, step(1));
    await h.preview(step(-1));
    await h.go();
    const summary = h.loop.meters();
    expect(summary.speculation.count).toBe(1);
    expect(summary.speculation.perTurn).toBe(summary.speculation.usd);
  });
});

describe('a speculation the player contradicts', () => {
  /** A game master that answers only when the test lets it, or when its call is aborted. */
  function slowHarness() {
    const engine = createEngine(gatehouseSnapshot(), {
      seed: GATEHOUSE_SEED,
      templates: TEMPLATES,
    });
    const room = createRoom({ engine });
    const registry = createEngineRegistry({ engine, seed: GATEHOUSE_SEED, templates: TEMPLATES });
    const waiting: (() => void)[] = [];
    const gm = {
      turn: (_request: GmTurnRequest, options?: { signal?: AbortSignal }) =>
        new Promise<never | GmTurnResponse>((resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          waiting.push(() =>
            resolve({ narration: 'answered', trace: [], stop_reason: 'end_turn', memory: {} }),
          );
        }),
    };
    const loop = createGmLoop({ room, registry, gm });
    room.setGmFrames((socket, message) => loop.handle(socket, message));
    const socket = fakeSocket();
    room.handle(socket, { type: 'join', room: DEFAULT_ROOM, protocol: 1 });
    socket.received.length = 0;
    return { room, loop, socket, waiting };
  }

  it('is cancelled rather than waited out, so the player is not queued behind a wrong guess', async () => {
    const h = slowHarness();
    h.room.handle(h.socket, { type: 'speculate', room: DEFAULT_ROOM, turn: 0, intent: step(1) });
    // The guess is genuinely in the air: the game master has been asked and has not answered.
    await vi.waitFor(() => expect(h.waiting).toHaveLength(1));

    // The player asks for something else. The guess is now known to be wrong AND is the only
    // thing between them and their answer, so it is aborted rather than waited out.
    h.room.handle(h.socket, {
      type: 'preview_request',
      room: DEFAULT_ROOM,
      turn: 0,
      intent: step(-1),
    });
    await vi.waitFor(() => expect(h.waiting).toHaveLength(2));
    h.waiting[1]?.();
    await h.loop.idle();
    expect(previews(h.socket).at(-1)?.text).toBe('answered');
  });
});

/**
 * The count cap is not the bound that matters in a fight. Since ALE-32 the game master takes the
 * NPC turns *inside* the preview call, on the clone, so one speculation in an encounter pays for
 * the player's action and every reaction to it — a number this loop cannot know before it makes
 * the call. So there is a second ceiling, in dollars.
 */
describe('the speculation dollar ceiling', () => {
  /** A game master whose every answer costs about fifty cents in output tokens. */
  function expensiveHarness(usdPerTurn?: number) {
    const engine = createEngine(gatehouseSnapshot(), {
      seed: GATEHOUSE_SEED,
      templates: TEMPLATES,
    });
    const room = createRoom({ engine });
    const registry = createEngineRegistry({ engine, seed: GATEHOUSE_SEED, templates: TEMPLATES });
    const asked: string[] = [];
    const gm = {
      turn: async (request: GmTurnRequest): Promise<GmTurnResponse> => {
        asked.push(request.phase);
        return {
          narration: 'an expensive silence',
          trace: [],
          stop_reason: 'end_turn',
          memory: {},
          usage: { input_tokens: 0, output_tokens: 20_000 }, // $0.50 at list price
        };
      },
    };
    const loop = createGmLoop({
      room,
      registry,
      gm,
      ...(usdPerTurn === undefined ? {} : { speculationUsdPerTurn: usdPerTurn }),
    });
    room.setGmFrames((socket, message) => loop.handle(socket, message));
    const socket = fakeSocket();
    room.handle(socket, { type: 'join', room: DEFAULT_ROOM, protocol: 1 });
    return { room, loop, socket, asked };
  }

  const hover = async (h: ReturnType<typeof expensiveHarness>, intent: Intent): Promise<void> => {
    h.room.handle(h.socket, {
      type: 'speculate',
      room: DEFAULT_ROOM,
      turn: h.room.turn(),
      intent,
    });
    await h.loop.idle();
  };

  it('stops after one speculation the turn could not afford, though the count allows two', async () => {
    const h = expensiveHarness();
    await hover(h, step(1));
    await hover(h, step(-1));

    // The first always runs — nothing can price a call before making it. The second is refused on
    // money rather than on count, which is the whole point of having both.
    expect(h.asked).toHaveLength(1);
    const stats = h.loop.speculation();
    expect(stats).toMatchObject({ spent: 1, dropped: 1, budget: 2, usdBudget: 0.3 });
    expect(stats.usd).toBeCloseTo(0.5, 5);
  });

  it('lets a generous ceiling through, so it is the money and not an accident', async () => {
    const h = expensiveHarness(10);
    await hover(h, step(1));
    await hover(h, step(-1));
    expect(h.asked).toHaveLength(2);
    expect(h.loop.speculation()).toMatchObject({ spent: 2, dropped: 0 });
  });
});
