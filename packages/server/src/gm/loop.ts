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
import {
  createTurnCache,
  decisionKey,
  previewKey,
  DEFAULT_CACHE_SIZE,
  type CachedDecision,
  type CachedPreview,
  type CacheStats,
} from './cache.js';
import { LIVE_ENGINE_TOKEN, type EngineRegistry } from './engines.js';
import {
  createMeters,
  type Meters,
  type MeterSummary,
  type TurnMeter,
  type TurnMeters,
} from './meters.js';
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
 * **Both are cached by (state hash, intent).** A preview asked twice of the same world returns from
 * memory without a clone, an HTTP hop or a model call, and so does an NPC's decision (ALE-22). The
 * hash *is* the invalidation: a changed world is a changed key. Nothing cached is authoritative —
 * every call in a cached plan is re-validated against the real engine before it commits.
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
  /** Entries the preview and NPC-decision caches keep. 0 turns caching off entirely (ALE-22). */
  cacheSize?: number;
  /** Memory blocks to start from. Non-empty when resuming a save (ALE-23). */
  memory?: MemoryBlocks;
  /** Somewhere to note a GM failure. Defaults to nothing; `buildApp` passes the Fastify logger. */
  log?: (message: string) => void;
  /**
   * Called once per player turn with what it cost and how long it took (ALE-24). `buildApp` sends
   * it to the recorder, so the meters end up in the JSONL beside the turns they measured.
   */
  onMeter?: (meter: TurnMeters) => void;
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
  /**
   * Warms the preview cache for intents the player might pick, while they are deliberating
   * (ALE-22). Sends nothing, stages nothing, and yields the moment a real frame arrives; the only
   * trace it leaves is that the preview the player does ask for may already be waiting.
   *
   * Which intents are "likely" is the UI's question, not this loop's — it is the same list the
   * client already greys out or highlights — so it is passed in rather than guessed at here.
   */
  speculate(intents: (Intent | null)[]): Promise<void>;
  /** Cache hits, misses and size, for the meters and for tests. */
  cache(): { preview: CacheStats; decisions: CacheStats };
  /** This session so far: p50/p95 after GO and cost per turn (ALE-24). */
  meters(): MeterSummary;
}

export function createGmLoop(options: GmLoopOptions): GmLoop {
  const { room, registry, gm } = options;
  const previewBudget = options.previewBudgetMs ?? PREVIEW_BUDGET_MS;
  const resolveBudget = options.resolveBudgetMs ?? RESOLVE_BUDGET_MS;
  const narrateBudget = options.narrateBudgetMs ?? NARRATE_BUDGET_MS;
  const maxNpcTurns = options.maxNpcTurns ?? MAX_NPC_TURNS;
  const log = options.log ?? (() => {});
  const onMeter = options.onMeter ?? ((): void => {});
  const liveDeps: GmToolDeps = { registry, room };
  const meters: Meters = createMeters();
  const cacheSize = options.cacheSize ?? DEFAULT_CACHE_SIZE;
  const caching = cacheSize > 0;
  const previews = createTurnCache<CachedPreview>(cacheSize);
  const decisions = createTurnCache<CachedDecision>(cacheSize);

  let pending: PendingPreview | null = null;
  let memory: MemoryBlocks = options.memory ?? EMPTY_MEMORY;
  /** One phase at a time. Two overlapping GOs would interleave mutations on one engine. */
  let inFlight: Promise<void> = Promise.resolve();
  let busy = false;
  /** Set when a real frame arrives, so speculation stops between intents instead of racing it. */
  let abandonSpeculation = false;
  /**
   * The turn being metered. Opened by whatever the player does first and closed by GO, so the
   * previews they discarded before committing are counted against the turn they were deliberating
   * over — that money was spent whether or not they used the answer.
   */
  let turnMeter: TurnMeter | null = null;
  const meter = (): TurnMeter => (turnMeter ??= meters.open(room.turn()));

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
  ): Promise<{
    narration: string;
    calls: GmToolCall[];
    diffs: Diff[];
    failed: string | null;
    /** What the model charged for this call, for the meters (ALE-24). Absent from the stub. */
    usage: Record<string, number> | undefined;
  }> => {
    const nothing = { narration: '', calls: [], diffs: [], usage: undefined };
    if (!gm) return { ...nothing, failed: 'no game master is configured' };
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
      return { narration: response.narration, calls, diffs, failed: null, usage: response.usage };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`gm ${phase} failed: ${reason}`);
      return { ...nothing, failed: reason };
    }
  };

  /**
   * Puts one planned call through the real engine. The plan may have come from a preview the
   * player just watched or from a cache entry, and neither is evidence: the engine re-validates
   * and re-rolls, and `false` means the rest of the batch was planned on a world that did not
   * happen. The rejection is in the recording with the engine's reason.
   */
  const replayCall = (call: GmToolCall): boolean => {
    const response = executeGmToolRequest(liveDeps, {
      session: room.id,
      turn: room.turn(),
      engineToken: LIVE_ENGINE_TOKEN,
      callId: null,
      tool: call.name,
      input: call.args,
    });
    if (!response.ok) {
      log(`${call.name} was refused on the real engine: ${response.reason ?? 'no reason'}`);
    }
    return response.ok;
  };

  // -------------------------------------------------------------------------------------------
  // Preview — on a clone, always
  // -------------------------------------------------------------------------------------------

  /**
   * One preview, from the cache or from the game master. Returns what a preview *is* — prose, the
   * diffs to show, and the calls GO will re-validate — or the engine's reason for refusing the
   * player's intent. Shared by the frame handler and by speculation so there is one preview path
   * rather than two that could disagree about what gets cached.
   */
  const computePreview = async (
    intent: Intent | null,
    text: string | null,
    phase: 'preview' | 'speculate' = 'preview',
  ): Promise<CachedPreview | { refused: string }> => {
    const startedAt = Date.now();
    const key = previewKey(room.engine.hash(), intent, text);
    if (caching) {
      const hit = previews.get(key);
      // A hit costs no clone, no HTTP hop and no model call: the world is bit-for-bit the world
      // this answer was computed on, and GO will re-validate it against the real engine either
      // way. `stateSummary` is derived from that same state, so there is nothing left to ask.
      if (hit) {
        meter().record(phase, { startedAt, endedAt: Date.now(), cached: true });
        return hit;
      }
    }

    const clone = registry.clone();
    // Nothing may mutate the real world while a preview is in flight, whatever engine token a tool
    // call claims. The clone is the isolation; this is the assertion that it held.
    registry.seal('That was a preview: nothing is committed until the player presses GO.');
    try {
      const diffs: Diff[] = [];
      if (intent) {
        const verdict = clone.engine.apply(intent);
        // The player learns their action is illegal before GO rather than after it, and the real
        // engine was never asked — the rejection came from the clone. Not cached: no model call
        // was made, so there is nothing a second refusal would save.
        if (!verdict.ok) return { refused: verdict.reason };
        diffs.push(...verdict.diff);
      }

      const answer = await ask(
        'preview',
        {
          engineToken: clone.token,
          intent,
          text,
          snapshot: clone.engine.snapshot(),
        },
        previewBudget,
      );
      diffs.push(...answer.diffs);

      const entry: CachedPreview = {
        text: answer.narration || fallbackPreviewText(intent, answer.failed),
        diffs,
        calls: answer.calls,
      };
      // A turn the game master never answered is not memoised: a timeout is a fact about one
      // moment, and caching it would make a blip permanent for as long as the world stands still.
      if (caching && !answer.failed) previews.set(key, entry);
      meter().record(phase, {
        startedAt,
        endedAt: Date.now(),
        usage: answer.usage,
        failed: answer.failed,
      });
      return entry;
    } finally {
      // The clone dies with the preview. Nothing can act on it afterwards, so a late tool call
      // from a timed-out GM is refused rather than landing on a world nobody is looking at.
      registry.release(clone.token);
      registry.seal(null);
    }
  };

  const preview = async (socket: RoomSocket, message: PreviewRequestMessage): Promise<void> => {
    const result = await computePreview(message.intent, message.text ?? null);
    if ('refused' in result) {
      pending = null;
      refuse(socket, result.refused);
      return;
    }
    pending = {
      turn: room.turn(),
      hash: room.engine.hash(),
      intent: message.intent,
      calls: result.calls,
      text: result.text,
      diffs: result.diffs,
    };
    // The preview goes to the player who asked for it: it is their deliberation, and nothing in
    // it has happened. Only committed diffs and narration are broadcast to the room.
    const frame: PreviewMessage = {
      type: 'preview',
      room: room.id,
      turn: room.turn(),
      text: result.text,
      diffs: result.diffs,
    };
    socket.send(JSON.stringify(frame));
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

    // GO's own work: re-validating the player's intent and every previewed call against the real
    // engine. The blueprint budgets it under 100 ms because it is pure engine, no model.
    const startedAt = Date.now();
    if (staged.intent) {
      const verdict = room.commit(staged.intent);
      if (!verdict.ok) {
        // The world moved between the preview and GO. Nothing was applied; preview again.
        refuse(socket, verdict.reason);
        return;
      }
    }

    for (const call of staged.calls) if (!replayCall(call)) break;
    meter().record('validate', { startedAt, endedAt: Date.now() });

    await resolve();
    await narrate(staged);
    // The turn is over and idle: what it cost is settled, and goes to the recording (ALE-24).
    onMeter(meter().finish());
    turnMeter = null;
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
        // The same world and the same NPC is the same question, so the answer is memoised too
        // (ALE-22). What comes back is the *plan* — the mutations the game master asked for — and
        // it is replayed through the very same `/gm/tool` door, so the engine validates every call
        // and rolls its own dice afresh. A cached decision can therefore fail where the first one
        // succeeded, which is correct: the cache remembers what an NPC decided to try, never what
        // the world let it do.
        const startedAt = Date.now();
        const key = decisionKey(room.engine.hash(), acting);
        const hit = caching ? decisions.get(key) : undefined;
        if (hit) {
          for (const call of hit) if (!replayCall(call)) break;
          meter().record('resolve', { startedAt, endedAt: Date.now(), cached: true });
        } else {
          const answer = await ask(
            'resolve',
            { engineToken: LIVE_ENGINE_TOKEN, intent: null, text: null, snapshot, acting },
            resolveBudget,
          );
          if (caching && !answer.failed) decisions.set(key, answer.calls);
          meter().record('resolve', {
            startedAt,
            endedAt: Date.now(),
            usage: answer.usage,
            failed: answer.failed,
          });
        }
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
    const startedAt = Date.now();
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
    meter().record('narrate', {
      startedAt,
      endedAt: Date.now(),
      usage: answer.usage,
      failed: answer.failed,
    });
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
    // Speculation is work nobody asked for, so a real frame takes the loop back: the flag stops it
    // at the next intent, and chaining on `inFlight` lets the one already in the air unwind first
    // rather than interleaving two previews on one registry.
    abandonSpeculation = true;
    inFlight = inFlight
      .catch(() => {})
      .then(work)
      .catch((error: unknown) => {
        refuse(socket, 'Something went wrong running that turn.');
        log(`gm loop failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        busy = false;
      });
  };

  const speculate = (intents: (Intent | null)[]): Promise<void> => {
    // Speculation only fills a cache. It stages nothing, sends nothing, and yields to the player,
    // so the worst case of being wrong about what they will pick is a model call nobody used.
    if (!caching || !gm || busy) return inFlight;
    abandonSpeculation = false;
    inFlight = inFlight
      .catch(() => {})
      .then(async () => {
        for (const intent of intents) {
          if (abandonSpeculation || busy) return;
          await computePreview(intent, null, 'speculate');
        }
      })
      .catch((error: unknown) => {
        log(`speculation failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    return inFlight;
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
    speculate,
    cache: () => ({ preview: previews.stats(), decisions: decisions.stats() }),
    meters: () => meters.summary(),
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
