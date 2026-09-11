import {
  type Diff,
  type EntityId,
  type GmToolCall,
  type GoMessage,
  type Intent,
  type PreviewMessage,
  type PreviewRequestMessage,
  type Snapshot,
  type StateHash,
} from '@deliberate/protocol';

import type { Room, RoomSocket } from '../room.js';
import { LIVE_ENGINE_TOKEN, type EngineRegistry } from './engines.js';
import { EMPTY_MEMORY, type GmPhase, type GmService, type MemoryBlocks } from './service.js';
import { executeGmToolRequest, type GmToolDeps } from './tool.js';

/**
 * Deliberate → Preview → GO → Resolve → Narrate (ALE-32). The blueprint's turn loop, with the
 * engine as the only mutator on either side of GO.
 *
 * **Preview does not mutate.** It clones the engine, applies the player's intent to the clone, and
 * lets the game master act on the clone through the same `/gm/tool` door it will use for real.
 * The real engine is never passed to a preview, so its state hash is byte-identical before and
 * after — including a preview in which the GM successfully mutated several things. `loop.test.ts`
 * asserts exactly that.
 *
 * **GO does not trust the preview.** The clone reseeded its RNG and the world may have moved since,
 * so a previewed verdict is a telegraph, not evidence. GO re-validates the player's intent and
 * every previewed call against the real engine, in order, stopping at the first rejection the way
 * the GM's own batches do. A player may preview, change their mind, preview again, and GO: only
 * the last preview is pending, and each preview starts from a fresh clone of the real state.
 *
 * **Resolve consults the GM for NPC turns.** M1 has no code brains (roadmap P1): an entity whose
 * `brain.policy` is `gm` takes its turn by the server asking the game master what it does, on the
 * real engine. Turns the GM leaves open are ended by the server, so a silent model cannot stall
 * the encounter forever.
 */

/** Phase budgets from docs/blueprint.md. Structure, not micro-optimisation: nothing may hang. */
export const PREVIEW_BUDGET_MS = 8_000;
export const RESOLVE_BUDGET_MS = 6_000;
export const NARRATE_BUDGET_MS = 3_000;

/** Hard stop on NPC turns resolved in one GO, so a loop in the world cannot become a loop here. */
const MAX_NPC_TURNS = 12;

/** The GM's own brain policy. `content/npcs` stamps it on all three archetypes (ALE-16). */
export const GM_BRAIN_POLICY = 'gm';

export interface PendingPreview {
  turn: number;
  /** The real engine's hash when the preview was taken. Informational: GO re-validates regardless. */
  hash: StateHash;
  intent: Intent | null;
  /** Mutations the GM landed on the clone, in order. GO re-validates each against the real engine. */
  calls: GmToolCall[];
  text: string;
  diffs: Diff[];
}

export interface GmLoopOptions {
  room: Room;
  registry: EngineRegistry;
  /** `null` runs the loop without a game master: preview shows the engine's own resolution. */
  gm: GmService | null;
  previewBudgetMs?: number;
  resolveBudgetMs?: number;
  narrateBudgetMs?: number;
  maxNpcTurns?: number;
  /** Somewhere to note a GM failure. Defaults to nothing; `buildApp` passes the Fastify logger. */
  log?: (message: string) => void;
}

export interface GmLoop {
  /** Handles one `preview_request` or `go` frame. */
  handle(socket: RoomSocket, message: PreviewRequestMessage | GoMessage): void;
  /** The preview `go` would commit, or null. Exposed for tests and for `/healthz`. */
  pending(): PendingPreview | null;
  /** Resolves once every in-flight phase has finished. Tests await this instead of sleeping. */
  idle(): Promise<void>;
  /** The memory blocks the GM service handed back last. Node persists them; the service does not. */
  memory(): MemoryBlocks;
}

export function createGmLoop(options: GmLoopOptions): GmLoop {
  const { room, registry, gm } = options;
  const previewBudget = options.previewBudgetMs ?? PREVIEW_BUDGET_MS;
  const resolveBudget = options.resolveBudgetMs ?? RESOLVE_BUDGET_MS;
  const narrateBudget = options.narrateBudgetMs ?? NARRATE_BUDGET_MS;
  const maxNpcTurns = options.maxNpcTurns ?? MAX_NPC_TURNS;
  const log = options.log ?? (() => {});
  const liveDeps: GmToolDeps = { registry, room };

  let pending: PendingPreview | null = null;
  let memory: MemoryBlocks = EMPTY_MEMORY;
  /** One phase at a time. Two overlapping GOs would interleave mutations on one engine. */
  let inFlight: Promise<void> = Promise.resolve();
  let busy = false;

  const refuse = (socket: RoomSocket, reason: string): void => room.refuse(socket, reason);

  /** Calls the service, never throws, and degrades to "no game master answered" on any failure. */
  const ask = async (
    phase: GmPhase,
    body: {
      engineToken: string | null;
      intent: Intent | null;
      text: string | null;
      snapshot: Snapshot;
      acting?: EntityId | null;
    },
    budgetMs: number,
    onChunk?: (chunk: string) => void,
  ): Promise<{ narration: string; calls: GmToolCall[]; diffs: Diff[]; failed: string | null }> => {
    if (!gm) return { narration: '', calls: [], diffs: [], failed: 'no game master is configured' };
    try {
      const response = await gm.turn(
        {
          session: room.id,
          turn: room.turn(),
          phase,
          engine_token: body.engineToken,
          state: stateSummary(body.snapshot, body.acting ?? null),
          entities: Object.keys(body.snapshot.entities),
          player_intent: body.intent,
          player_text: body.text,
          memory,
        },
        { signal: AbortSignal.timeout(budgetMs), ...(onChunk ? { onChunk } : {}) },
      );
      memory = response.memory ?? memory;
      const calls: GmToolCall[] = [];
      const diffs: Diff[] = [];
      for (const entry of response.trace) {
        if (entry.executed === false) continue;
        if (entry.diff) diffs.push(...entry.diff);
        if (entry.ok && (entry.kind ?? 'mutation') === 'mutation') {
          calls.push({ name: entry.tool, args: entry.input ?? {} });
        }
      }
      return { narration: response.narration, calls, diffs, failed: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`gm ${phase} failed: ${reason}`);
      return { narration: '', calls: [], diffs: [], failed: reason };
    }
  };

  // -------------------------------------------------------------------------------------------
  // Preview — on a clone, always
  // -------------------------------------------------------------------------------------------

  const preview = async (socket: RoomSocket, message: PreviewRequestMessage): Promise<void> => {
    const clone = registry.clone();
    // Nothing may mutate the real world while a preview is in flight, whatever engine token a tool
    // call claims. The clone is the isolation; this is the assertion that it held.
    registry.seal('That was a preview: nothing is committed until the player presses GO.');
    try {
      const diffs: Diff[] = [];
      if (message.intent) {
        const verdict = clone.engine.apply(message.intent);
        if (!verdict.ok) {
          // The player learns their action is illegal before GO rather than after it, and the real
          // engine was never asked — the rejection came from the clone.
          pending = null;
          refuse(socket, verdict.reason);
          return;
        }
        diffs.push(...verdict.diff);
      }

      const answer = await ask(
        'preview',
        {
          engineToken: clone.token,
          intent: message.intent,
          text: message.text ?? null,
          snapshot: clone.engine.snapshot(),
        },
        previewBudget,
      );
      diffs.push(...answer.diffs);

      const text = answer.narration || fallbackPreviewText(message.intent, answer.failed);
      pending = {
        turn: room.turn(),
        hash: room.engine.hash(),
        intent: message.intent,
        calls: answer.calls,
        text,
        diffs,
      };
      // The preview goes to the player who asked for it: it is their deliberation, and nothing in
      // it has happened. Only committed diffs and narration are broadcast to the room.
      const frame: PreviewMessage = {
        type: 'preview',
        room: room.id,
        turn: room.turn(),
        text,
        diffs,
      };
      socket.send(JSON.stringify(frame));
    } finally {
      // The clone dies with the preview. Nothing can act on it afterwards, so a late tool call
      // from a timed-out GM is refused rather than landing on a world nobody is looking at.
      registry.release(clone.token);
      registry.seal(null);
    }
  };

  // -------------------------------------------------------------------------------------------
  // GO — re-validate against the real engine
  // -------------------------------------------------------------------------------------------

  const go = async (socket: RoomSocket, message: GoMessage): Promise<void> => {
    const staged = pending;
    pending = null;
    if (!staged || staged.turn !== message.turn) {
      refuse(socket, 'Preview an action before pressing GO.');
      return;
    }

    if (staged.intent) {
      const verdict = room.commit(staged.intent);
      if (!verdict.ok) {
        // The world moved between the preview and GO. Nothing was applied; preview again.
        refuse(socket, verdict.reason);
        return;
      }
    }

    for (const call of staged.calls) {
      const response = executeGmToolRequest(liveDeps, {
        session: room.id,
        turn: room.turn(),
        engineToken: LIVE_ENGINE_TOKEN,
        callId: null,
        tool: call.name,
        input: call.args,
      });
      if (!response.ok) {
        // The rest of the batch was planned on a world that did not happen. The rejection is in
        // the recording with the engine's reason, which is the evidence the ledger is built from.
        log(`go: ${call.name} was refused on the real engine: ${response.reason ?? 'no reason'}`);
        break;
      }
    }

    await resolve();
    await narrate(staged);
  };

  // -------------------------------------------------------------------------------------------
  // Resolve — initiative runs, and NPC turns go through the GM
  // -------------------------------------------------------------------------------------------

  const resolve = async (): Promise<void> => {
    for (let i = 0; i < maxNpcTurns; i++) {
      const snapshot = room.engine.snapshot();
      const acting = gmActor(snapshot);
      if (!acting) return;

      if (gm) {
        await ask(
          'resolve',
          { engineToken: LIVE_ENGINE_TOKEN, intent: null, text: null, snapshot, acting },
          resolveBudget,
        );
      }

      const after = room.engine.snapshot();
      if (gmActor(after) !== acting) continue;
      // The GM did not end the turn (or there is no GM). The server ends it, through the same
      // validated `end_turn` the GM would have called, so the encounter cannot stall on a silence.
      const verdict = room.commitGmCall(
        { kind: 'end_turn', entity: acting },
        {
          name: 'end_turn',
          args: { entity_id: acting },
        },
      );
      if (!verdict.ok) return;
    }
  };

  // -------------------------------------------------------------------------------------------
  // Narrate — streamed prose for what the engine did
  // -------------------------------------------------------------------------------------------

  const narrate = async (staged: PendingPreview): Promise<void> => {
    if (!gm) return;
    const turn = room.turn();
    const answer = await ask(
      'narrate',
      {
        engineToken: LIVE_ENGINE_TOKEN,
        intent: staged.intent,
        text: null,
        snapshot: room.engine.snapshot(),
      },
      narrateBudget,
      (chunk) => room.broadcast({ type: 'narration', room: room.id, turn, chunk, done: false }),
    );
    if (answer.failed) return;
    room.broadcast({ type: 'narration', room: room.id, turn, chunk: '', done: true });
  };

  // -------------------------------------------------------------------------------------------

  const run = (socket: RoomSocket, work: () => Promise<void>): void => {
    if (busy) {
      refuse(socket, 'The game master is still thinking about the last action.');
      return;
    }
    busy = true;
    inFlight = work()
      .catch((error: unknown) => {
        refuse(socket, 'Something went wrong running that turn.');
        log(`gm loop failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        busy = false;
      });
  };

  return {
    handle(socket, message) {
      if (message.turn !== room.turn()) {
        refuse(
          socket,
          `That was composed for turn ${message.turn}; the room is on turn ${room.turn()}.`,
        );
        socket.send(JSON.stringify(room.snapshotMessage()));
        return;
      }
      if (message.type === 'preview_request') run(socket, () => preview(socket, message));
      else run(socket, () => go(socket, message));
    },
    pending: () => pending,
    idle: () => inFlight,
    memory: () => memory,
  };
}

/**
 * The entity whose turn it is, when that entity is one the game master plays. `null` out of
 * combat, when it is the player's turn, or when the current entity is dead.
 */
export function gmActor(snapshot: Snapshot): EntityId | null {
  const init = snapshot.initiative;
  if (!init) return null;
  const id = init.order[init.current];
  if (!id) return null;
  const entity = snapshot.entities[id];
  if (!entity || entity.components.brain?.policy !== GM_BRAIN_POLICY) return null;
  if (entity.components.health?.conditions.includes('dead')) return null;
  return id;
}

/**
 * The read-only state summary that rides on `/turn`. Not authoritative and not the whole snapshot:
 * it is the orientation the GM needs before it starts asking questions, and `get_state` answers
 * from the engine for anything more. Small on purpose — it is measured against the 12k budget.
 */
export function stateSummary(snapshot: Snapshot, acting: EntityId | null): Record<string, unknown> {
  return {
    acting,
    clock: snapshot.world.clock,
    flags: snapshot.world.flags,
    quests: Object.values(snapshot.world.quests).map((q) => ({
      id: q.id,
      title: q.title,
      step: q.step,
      of: q.steps.length,
    })),
    initiative: snapshot.initiative,
    entities: Object.values(snapshot.entities).map((entity) => ({
      id: entity.id,
      name: entity.name,
      brain: entity.components.brain?.policy ?? 'none',
      faction: entity.components.faction?.id ?? null,
      at: entity.components.position
        ? { x: entity.components.position.x, y: entity.components.position.y }
        : null,
      hp: entity.components.health?.hp ?? null,
      maxHp: entity.components.health?.maxHp ?? null,
      conditions: entity.components.health?.conditions ?? [],
      disposition: entity.components.disposition?.toward ?? {},
    })),
  };
}

function fallbackPreviewText(intent: Intent | null, failed: string | null): string {
  const what = intent ? `${intent.kind} is legal from here.` : 'Nothing is staged.';
  if (!failed) return what;
  return `${what} No game master narrated it (${failed}).`;
}
