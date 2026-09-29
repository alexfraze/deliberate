import { describe, expect, it, vi } from 'vitest';

import { createEngine } from '@deliberate/engine';
import {
  GATEHOUSE_SEED,
  GATEHOUSE_PLAYER_ID,
  NPC_ARCHETYPES,
  gatehouseSnapshot,
  npcEntity,
} from '@deliberate/npcs';
import {
  DEFAULT_ROOM,
  type AbandonedMessage,
  type Entity,
  type ErrorMessage,
  type Intent,
  type PreviewMessage,
  type ServerMessage,
} from '@deliberate/protocol';

import { createRoom, type RoomSocket } from '../room.js';
import { createEngineRegistry } from './engines.js';
import { createGmLoop } from './loop.js';
import type { GmTurnRequest, GmTurnResponse, GmTurnOptions } from './service.js';
import type { TurnMeters } from './meters.js';
import { executeGmToolRequest } from './tool.js';

/**
 * ALE-52's evidence: **a player can abandon a preview they no longer want, ask something else at
 * once, and the abandoned call stops costing money.**
 *
 * Two of those three are wiring and are proved here against a fake. The third — that an abandoned
 * call stops *billing* — cannot be proved against a fake at all, because a fake has no bill. What
 * this file proves about the money is the part that is a property of our code: the model call is
 * actually aborted and cancelled at the service rather than merely ignored, and nothing about it
 * reaches the meters as a completed turn. The live half is in the PR description.
 *
 * The safety line has its own `describe`. **Cancelling a preview is safe and cancelling after GO is
 * not**, and the reason is structural: a preview runs on a clone and commits nothing, while after GO
 * each game master call mutates the real engine as it lands, so an abort between two of them leaves
 * the turn half-applied with nothing to roll back. The test below is what keeps the second case out
 * of the first case's control.
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

/** The player takes one step east or west. Legal from the gatehouse start. */
function step(dx: number): Intent {
  const start = gatehouseSnapshot().entities[GATEHOUSE_PLAYER_ID]?.components.position;
  return {
    kind: 'move',
    entity: GATEHOUSE_PLAYER_ID,
    to: { x: (start?.x ?? 0) + dx, y: start?.y ?? 0 },
  };
}

interface InFlight {
  request: GmTurnRequest;
  /** Let this call finish, with `output_tokens` worth of work to bill for. */
  answer: (outputTokens: number) => void;
  /** True once the loop aborted the signal it passed in. */
  aborted: () => boolean;
}

/**
 * A game master that answers only when the test lets it — the only way to have a call genuinely in
 * flight when the player changes their mind. It records the engine tokens `cancel` was fired at,
 * which is the assertion that the model call was *stopped* and not merely dropped on the floor.
 *
 * `ambient: { max: 0 }` because this file is about the player's cancel, and an ambient NPC turn
 * would add model calls to the meter lines it asserts on.
 */
function harness() {
  const engine = createEngine(gatehouseSnapshot(), { seed: GATEHOUSE_SEED, templates: TEMPLATES });
  const room = createRoom({ engine });
  const registry = createEngineRegistry({ engine, seed: GATEHOUSE_SEED, templates: TEMPLATES });
  const flight: InFlight[] = [];
  const cancelled: string[] = [];
  const meterLines: TurnMeters[] = [];
  const gm = {
    turn: (request: GmTurnRequest, options?: GmTurnOptions): Promise<GmTurnResponse> =>
      new Promise<GmTurnResponse>((resolve, reject) => {
        let aborted = false;
        options?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('This operation was aborted'));
        });
        flight.push({
          request,
          aborted: () => aborted,
          answer: (outputTokens) =>
            resolve({
              narration: `answered ${request.phase}`,
              trace: [],
              stop_reason: 'end_turn',
              memory: {},
              usage: { input_tokens: 0, output_tokens: outputTokens },
            }),
        });
      }),
    cancel: (engineToken: string) => cancelled.push(engineToken),
  };
  const loop = createGmLoop({
    room,
    registry,
    gm,
    ambient: { max: 0 },
    onMeter: (meter) => meterLines.push(meter),
  });
  room.setGmFrames((socket, message) => loop.handle(socket, message));

  const socket = fakeSocket();
  room.handle(socket, { type: 'join', room: DEFAULT_ROOM, protocol: 1 });
  socket.received.length = 0;

  /** Asks for a preview and waits until the game master has actually been called. */
  const ask = async (intent: Intent | null): Promise<InFlight> => {
    const before = flight.length;
    room.handle(socket, {
      type: 'preview_request',
      room: DEFAULT_ROOM,
      turn: room.turn(),
      intent,
    });
    await vi.waitFor(() => expect(flight.length).toBe(before + 1));
    return flight[before] as InFlight;
  };
  const abandon = (): void => {
    room.handle(socket, { type: 'abandon', room: DEFAULT_ROOM, turn: room.turn() });
  };

  return { engine, room, registry, loop, socket, flight, cancelled, meterLines, ask, abandon };
}

const frames = <T extends ServerMessage>(
  socket: { received: ServerMessage[] },
  type: T['type'],
): T[] => socket.received.filter((m): m is T => m.type === type);

describe('abandoning a preview in flight', () => {
  it('stops it, says so in its own words, and sends no preview for it', async () => {
    const h = harness();
    const call = await h.ask(step(1));

    h.abandon();
    expect(call.aborted()).toBe(true);
    await h.loop.idle();

    const said = frames<AbandonedMessage>(h.socket, 'abandoned');
    expect(said).toHaveLength(1);
    expect(said[0]?.note).toMatch(/abandoned that/i);
    // Not an error frame: the player did not do anything wrong and nothing broke.
    expect(frames<ErrorMessage>(h.socket, 'error')).toHaveLength(0);
    // And not a preview either. Whatever the game master would have said describes a question that
    // was withdrawn.
    expect(frames<PreviewMessage>(h.socket, 'preview')).toHaveLength(0);
  });

  it('aborts the model call and cancels it at the service, rather than ignoring the answer', async () => {
    const h = harness();
    const call = await h.ask(step(1));
    const token = call.request.engine_token;

    h.abandon();
    await h.loop.idle();

    // Both halves, because either alone leaves money on the table. The abort frees this process;
    // the `cancel` is what reaches the service, whose `/turn` is a synchronous route running in a
    // worker thread — a hung-up connection there does not stop the stream from Claude.
    expect(call.aborted()).toBe(true);
    expect(h.cancelled).toEqual([token]);
  });

  it('bills nothing for it: the meters count it as abandoned, not as a completed turn', async () => {
    const h = harness();
    const thrownAway = await h.ask(step(1));
    h.abandon();
    await h.loop.idle();
    expect(thrownAway.aborted()).toBe(true);

    // The preview the player actually wanted, and the turn it becomes.
    const kept = await h.ask(step(-1));
    kept.answer(1_000);
    await h.loop.idle();
    h.room.handle(h.socket, { type: 'go', room: DEFAULT_ROOM, turn: h.room.turn() });
    await vi.waitFor(() => expect(h.flight).toHaveLength(3));
    h.flight[2]?.answer(200); // narrate
    await h.loop.idle();

    const meter = h.meterLines.at(-1);
    expect(meter?.abandoned).toBe(1);
    // Exactly the two calls that produced something, and exactly their tokens. The abandoned call
    // is in neither number: it never came back, so there is nothing of it to price.
    expect(meter?.calls).toBe(2);
    expect(meter?.tokens.output).toBe(1_200);
    // Nor did it lengthen the preview the player is judged to have waited for.
    expect(meter?.latencyMs.preview).toBeGreaterThanOrEqual(0);
    expect(h.loop.meters().abandoned).toBe(1);
  });

  it('frees the loop at once, so the next question is answered rather than refused', async () => {
    const h = harness();
    await h.ask(step(1));
    h.abandon();

    // No `await idle()` first: the point of the whole issue is that the player does not wait for
    // the call they abandoned to unwind before asking something else.
    const next = await h.ask(step(-1));
    next.answer(100);
    await h.loop.idle();

    expect(frames<ErrorMessage>(h.socket, 'error')).toHaveLength(0);
    expect(frames<PreviewMessage>(h.socket, 'preview').at(-1)?.text).toBe('answered preview');
  });

  it('stages nothing, so GO is refused until the player previews again', async () => {
    const h = harness();
    await h.ask(step(1));
    h.abandon();
    await h.loop.idle();

    expect(h.loop.pending()).toBeNull();
    h.room.handle(h.socket, { type: 'go', room: DEFAULT_ROOM, turn: h.room.turn() });
    await h.loop.idle();
    expect(frames<ErrorMessage>(h.socket, 'error').at(-1)?.reason).toMatch(/Preview an action/);
  });

  it('does not remember the answer it threw away', async () => {
    const h = harness();
    await h.ask(step(1));
    h.abandon();
    await h.loop.idle();

    // The same intent again asks the game master again. A cancelled call answered nothing, and
    // caching a non-answer would make one abandoned preview a permanent blank for that world.
    const again = await h.ask(step(1));
    again.answer(100);
    await h.loop.idle();
    expect(h.flight).toHaveLength(2);
    expect(h.loop.cache().preview).toMatchObject({ hits: 0, misses: 2 });
  });

  it('releases the clone, and a late call on its token is refused rather than landing live', async () => {
    const h = harness();
    const call = await h.ask(step(1));
    const token = call.request.engine_token ?? '';
    const before = h.engine.hash();

    h.abandon();
    await h.loop.idle();
    expect(h.registry.clones()).toBe(0);

    // The service's worker thread is still unwinding and may yet try one more tool call. It is
    // refused by name — not silently redirected to the live engine, which is the bug the token
    // registry exists to make impossible.
    const late = executeGmToolRequest(
      { registry: h.registry, room: h.room },
      {
        session: h.room.id,
        turn: h.room.turn(),
        engineToken: token,
        callId: 'late',
        tool: 'move',
        input: { entity_id: GATEHOUSE_PLAYER_ID, to: { x: 0, y: 0 } },
      },
    );
    expect(late.ok).toBe(false);
    expect(late.reason).toContain(token);
    expect(late.reason).toMatch(/preview it belonged to is over/);
    expect(h.engine.hash()).toBe(before);
  });
});

describe('the safety line: a committed turn cannot be abandoned', () => {
  it('refuses the frame, says why, and stops nothing', async () => {
    const h = harness();
    const preview = await h.ask(step(1));
    preview.answer(1_000);
    await h.loop.idle();

    h.room.handle(h.socket, { type: 'go', room: DEFAULT_ROOM, turn: h.room.turn() });
    // The turn is committing: the player's move has landed and the game master is narrating it.
    await vi.waitFor(() => expect(h.flight).toHaveLength(2));
    h.socket.received.length = 0;

    h.abandon();
    // A refusal, not an abandonment. Stopping here would leave a turn half-applied — some of its
    // mutations committed, some not — and there is no rollback to reach for.
    const refusal = frames<ErrorMessage>(h.socket, 'error').at(-1);
    expect(refusal?.reason).toMatch(/Too late to abandon/);
    expect(refusal?.reason).toMatch(/half-changed/);
    expect(frames<AbandonedMessage>(h.socket, 'abandoned')).toHaveLength(0);
    // And nothing in flight was touched: the turn lands as it would have.
    expect(h.flight[1]?.aborted()).toBe(false);
    expect(h.cancelled).toEqual([]);

    h.flight[1]?.answer(200);
    await h.loop.idle();
    expect(h.meterLines.at(-1)?.abandoned).toBe(0);
  });
});

describe('abandoning while a speculation is warming', () => {
  it('stops the guess and leaves the registry able to guess again', async () => {
    const h = harness();
    h.room.handle(h.socket, {
      type: 'speculate',
      room: DEFAULT_ROOM,
      turn: h.room.turn(),
      intent: step(1),
    });
    await vi.waitFor(() => expect(h.flight).toHaveLength(1));

    h.abandon();
    expect(h.flight[0]?.aborted()).toBe(true);
    // The guess was a model call too, so stopping it stops a bill too.
    expect(h.cancelled).toEqual([h.flight[0]?.request.engine_token]);
    await h.loop.idle();

    // Nothing is wedged: `speculatingKey` was cleared, so the pointer can bet again on the same
    // turn, and the counters still add up.
    expect(h.loop.speculation()).toMatchObject({ turn: 0, spent: 1 });
    h.room.handle(h.socket, {
      type: 'speculate',
      room: DEFAULT_ROOM,
      turn: h.room.turn(),
      intent: step(-1),
    });
    await vi.waitFor(() => expect(h.flight).toHaveLength(2));
    h.flight[1]?.answer(100);
    await h.loop.idle();
    expect(h.loop.speculation()).toMatchObject({ spent: 2 });
  });
});

describe('abandoning with nothing in flight', () => {
  it('is answered as an abandonment rather than as an error', async () => {
    const h = harness();
    h.abandon();
    // Escape is a reflex and a player will press it a beat late. Dressing a harmless no-op as an
    // error teaches them to distrust the errors that matter.
    expect(frames<AbandonedMessage>(h.socket, 'abandoned').at(-1)?.note).toMatch(
      /Nothing was in flight/,
    );
    expect(frames<ErrorMessage>(h.socket, 'error')).toHaveLength(0);
  });
});
