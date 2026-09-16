import { describe, expect, it } from 'vitest';

import { createEngine, summarize } from '@deliberate/engine';
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
  type RecordedMeter,
  type ServerMessage,
} from '@deliberate/protocol';

import { createRoom, type RoomSocket } from '../room.js';
import { createEngineRegistry } from './engines.js';
import { createGmLoop } from './loop.js';
import { createMeters, tokensFrom, usdFor, PRICE_PER_MTOK, type TurnMeters } from './meters.js';
import type { GmTurnRequest, GmTurnResponse } from './service.js';
import { stubGmService, type ScriptedTurn } from './stub.js';
import { executeGmToolRequest } from './tool.js';

/**
 * ALE-24's evidence: **the meters appear in the recording, and a summary prints them per session.**
 *
 * The dollar figure is the part most easily got wrong, so it is asserted against hand-computed
 * arithmetic on the real list prices rather than against whatever the code happens to produce.
 */

const TEMPLATES: Record<string, Entity> = Object.fromEntries(
  NPC_ARCHETYPES.map((npc) => [npc.archetype, npcEntity(npc)]),
);

/** The usage block one M1 call actually reported: mostly cache, which is the whole point. */
const M1_USAGE = {
  input_tokens: 90,
  output_tokens: 400,
  cache_read_input_tokens: 5454,
  cache_creation_input_tokens: 0,
};

describe('pricing', () => {
  it('counts cache reads apart from fresh input, at a tenth of the price', () => {
    const tokens = tokensFrom(M1_USAGE);
    expect(tokens).toEqual({ input: 90, output: 400, cacheRead: 5454, cacheWrite: 0 });

    // 90 * $5 + 400 * $25 + 5454 * $0.50, per million.
    const expected = (90 * 5 + 400 * 25 + 5454 * 0.5) / 1_000_000;
    expect(usdFor(tokens)).toBeCloseTo(expected, 12);

    // Summing cached and uncached input would have charged 5544 tokens at the input price. That
    // is the mistake this split exists to prevent, and here it is, measured.
    const naive = ((90 + 5454) * 5 + 400 * 25) / 1_000_000;
    expect(naive / usdFor(tokens)).toBeGreaterThan(1.5);
  });

  it('uses the current claude-opus-5 list price', () => {
    expect(PRICE_PER_MTOK).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  });

  it('charges nothing for a phase the cache answered', () => {
    const meters = createMeters();
    const turn = meters.open(0);
    turn.record('preview', { startedAt: 1_000, endedAt: 1_000, cached: true });
    turn.record('validate', { startedAt: 1_000, endedAt: 1_020 });
    const meter = turn.finish();
    expect(meter.usd).toBe(0);
    expect(meter).toMatchObject({ calls: 0, cacheHits: 1 });
    expect(meter.latencyMs.preview).toBe(0);
  });

  it('adds a turn up by phase, and after-GO is validate plus resolve plus narrate', () => {
    const meters = createMeters();
    const turn = meters.open(3);
    turn.record('preview', { startedAt: 0, endedAt: 6_000, usage: M1_USAGE });
    turn.record('validate', { startedAt: 6_000, endedAt: 6_021 });
    turn.record('resolve', { startedAt: 6_021, endedAt: 10_021, usage: M1_USAGE });
    turn.record('resolve', { startedAt: 10_021, endedAt: 12_021, usage: M1_USAGE });
    turn.record('narrate', { startedAt: 12_021, endedAt: 15_021, usage: M1_USAGE });
    const meter = turn.finish();

    expect(meter.latencyMs).toEqual({
      preview: 6_000,
      validate: 21,
      resolve: 6_000,
      narrate: 3_000,
      afterGo: 9_021,
    });
    expect(meter.tokens.cacheRead).toBe(4 * 5454);
    expect(meter.calls).toBe(4);
    expect(meter.usd).toBeCloseTo(4 * usdFor(tokensFrom(M1_USAGE)), 12);
  });

  it('counts a speculated preview as money spent but not as time anybody waited', () => {
    const meters = createMeters();
    const turn = meters.open(0);
    turn.record('speculate', { startedAt: 0, endedAt: 9_000, usage: M1_USAGE });
    turn.record('preview', { startedAt: 9_000, endedAt: 9_000, cached: true });
    const meter = turn.finish();
    expect(meter.latencyMs.preview).toBe(0);
    expect(meter.usd).toBeGreaterThan(0);
  });
});

describe('the session summary', () => {
  it('reports the percentile after GO that M3 is graded on', () => {
    const meters = createMeters();
    for (const [i, afterGo] of [12_000, 3_000, 9_000, 4_000].entries()) {
      const turn = meters.open(i);
      turn.record('validate', { startedAt: 0, endedAt: afterGo });
      turn.record('preview', { startedAt: 0, endedAt: 2_000, usage: M1_USAGE });
      turn.finish();
    }
    const summary = meters.summary();
    expect(summary.turns).toBe(4);
    // Nearest rank over [3000, 4000, 9000, 12000]: p50 is the 2nd value, p95 the 4th. No
    // interpolation, because an interpolated percentile names a turn that never happened.
    expect(summary.afterGoMs.p50).toBe(4_000);
    expect(summary.afterGoMs.p95).toBe(12_000);
    expect(summary.afterGoMs.max).toBe(12_000);
    expect(summary.usd.perTurn).toBeCloseTo(usdFor(tokensFrom(M1_USAGE)), 12);
  });
});

// ---------------------------------------------------------------------------------------------
// End to end: a turn through the real loop, metered, recorded, and read back out of the JSONL
// ---------------------------------------------------------------------------------------------

function fakeSocket(): RoomSocket & { received: ServerMessage[] } {
  const received: ServerMessage[] = [];
  return {
    received,
    send(data) {
      received.push(JSON.parse(data) as ServerMessage);
    },
  };
}

function harness(script: (request: GmTurnRequest) => ScriptedTurn) {
  const engine = createEngine(gatehouseSnapshot(), { seed: GATEHOUSE_SEED, templates: TEMPLATES });
  const room = createRoom({ engine });
  const registry = createEngineRegistry({ engine, seed: GATEHOUSE_SEED, templates: TEMPLATES });
  const deps = { registry, room };
  const inner = stubGmService({
    script,
    call: (request) => executeGmToolRequest(deps, request),
  });
  // The stub reports no usage — it never called a model. Wrapping it is how a test gets a
  // realistic bill without spending one, and it is the same seam the ALE-17 harness tallies on.
  const gm = {
    policy: inner.policy,
    async turn(request: GmTurnRequest, options?: Parameters<typeof inner.turn>[1]) {
      const response: GmTurnResponse = await inner.turn(request, options);
      return { ...response, usage: { ...M1_USAGE } };
    },
  };
  const recorded: TurnMeters[] = [];
  const loop = createGmLoop({ room, registry, gm, onMeter: (m) => recorded.push(m) });
  room.setGmFrames((socket, message) => loop.handle(socket, message));

  const socket = fakeSocket();
  room.handle(socket, { type: 'join', room: DEFAULT_ROOM, protocol: 1 });

  const preview = async (intent: Intent | null): Promise<void> => {
    room.handle(socket, {
      type: 'preview_request',
      room: DEFAULT_ROOM,
      turn: room.turn(),
      intent,
    });
    await loop.idle();
  };
  const go = async (): Promise<void> => {
    room.handle(socket, { type: 'go', room: DEFAULT_ROOM, turn: room.turn() });
    await loop.idle();
  };
  return { engine, room, loop, socket, recorded, preview, go };
}

const HAIL: Intent = { kind: 'say', speaker: GATEHOUSE_PLAYER_ID, text: 'Hail.', to: GUARD_ID };

describe('metering a turn through the loop', () => {
  it('emits one meter per GO, with what the turn cost and how long it took', async () => {
    const h = harness(() => ({ narration: 'Halloran looks you over.' }));

    await h.preview(HAIL);
    await h.go();

    expect(h.recorded).toHaveLength(1);
    const meter = h.recorded[0]!;
    expect(meter.turn).toBe(0);
    // Preview and narrate each asked the game master once; nothing was cached.
    expect(meter.calls).toBe(2);
    expect(meter.cacheHits).toBe(0);
    expect(meter.usd).toBeCloseTo(2 * usdFor(tokensFrom(M1_USAGE)), 12);
    expect(meter.tokens.cacheRead).toBe(2 * M1_USAGE.cache_read_input_tokens);
    expect(meter.latencyMs.afterGo).toBe(
      meter.latencyMs.validate + meter.latencyMs.resolve + meter.latencyMs.narrate,
    );
  });

  it('bills a discarded preview to the turn it was discarded on, and a cached one to nobody', async () => {
    const h = harness(() => ({ narration: 'The yard waits.' }));

    // Preview, change your mind, preview the first thing again, then GO. Three requests, two
    // model calls, and the third came back from the (state hash, intent) cache (ALE-22).
    await h.preview(HAIL);
    await h.preview({ kind: 'move', entity: GATEHOUSE_PLAYER_ID, to: { x: 4, y: 7 } });
    await h.preview(HAIL);
    await h.go();

    const meter = h.recorded[0]!;
    expect(meter.cacheHits).toBe(1);
    // Two previews plus narrate. The abandoned preview is on the bill: that money was spent.
    expect(meter.calls).toBe(3);
    expect(meter.usd).toBeCloseTo(3 * usdFor(tokensFrom(M1_USAGE)), 12);
  });

  it('does not meter a GO the loop refused', async () => {
    const h = harness(() => ({ narration: 'Nothing yet.' }));
    await h.go();
    expect(h.socket.received.at(-1)?.type).toBe('error');
    expect(h.recorded).toHaveLength(0);
  });

  it('summarises the session the same way the CLI summarises the recording', async () => {
    const h = harness(() => ({ narration: 'A pause.' }));
    await h.preview(HAIL);
    await h.go();
    await h.preview(HAIL);
    await h.go();

    const live = h.loop.meters();
    expect(live.turns).toBe(2);
    // The live summary and the one computed from the recorded lines are the same function over
    // the same numbers, so a dashboard and a post-mortem can never disagree.
    const fromLines = summarize(h.recorded.map((m): RecordedMeter => ({ line: 'meter', ...m })));
    expect(fromLines).toEqual(live);
    expect(live.usd.perTurn).toBeGreaterThan(0);
  });
});
