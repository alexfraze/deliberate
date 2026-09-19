import {
  type Diff,
  type EntityId,
  type GmToolCall,
  type GoMessage,
  type Intent,
  type PreviewMessage,
  type PreviewRequestMessage,
  type Snapshot,
  type SpeculateMessage,
  type StateHash,
} from '@deliberate/protocol';

import type { Room, RoomSocket } from '../room.js';
import {
  ambientCandidates,
  GM_BRAIN_POLICY,
  type AmbientOptions,
  type AmbientSense,
} from './ambient.js';
import {
  createTurnCache,
  decisionKey,
  policyKey,
  previewKey,
  DEFAULT_CACHE_SIZE,
  type CachedDecision,
  type CachedPolicy,
  type CachedPreview,
  type CacheStats,
} from './cache.js';
import { LIVE_ENGINE_TOKEN, type EngineRegistry } from './engines.js';
import {
  createMeters,
  tokensFrom,
  usdFor,
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
 * **Resolve takes NPC turns from a skill cache first (ALE-37).** An entity whose `brain.policy` is
 * `gm` gets its turn from, in order: the exact-world decision cache; a *policy* the game master
 * wrote earlier, run in the GM service's sandbox with no model call; or, failing both, the model.
 * A policy proposes tool calls through the same `/gm/tool` door and can be refused like anything
 * else, and a policy that runs but lands nothing is retired rather than trusted. Turns the GM
 * leaves open are ended by the server, so a silent model cannot stall the encounter forever.
 */

/** Phase budgets from docs/blueprint.md. Structure, not micro-optimisation: nothing may hang. */
export const PREVIEW_BUDGET_MS = 8_000;
export const RESOLVE_BUDGET_MS = 6_000;
export const NARRATE_BUDGET_MS = 3_000;

/** Hard stop on NPC turns resolved in one GO, so a loop in the world cannot become a loop here. */
const MAX_NPC_TURNS = 12;

/**
 * Speculative previews the server will pay for in one player turn (ALE-40), and the reason there
 * is a number here at all.
 *
 * Every speculation is a real model call — a preview costs roughly a tenth of a dollar — so the
 * ceiling is not a tuning knob, it is the bound on how much a player's *pointer* can spend. Two is
 * chosen because a speculation the player then commits to costs nothing extra (it moves a call
 * they were going to make anyway earlier in wall-clock time), so the only money at risk is the
 * wrong guesses: at most two previews per turn, and in practice fewer, since the loop refuses to
 * run two at once and a hit spends nothing.
 *
 * It is enforced **here** and not only in the client, because the client is a browser and anyone
 * can open the console. `0` turns speculation off entirely; `src/index.ts` reads `GM_SPECULATE`.
 */
export const MAX_SPECULATIONS_PER_TURN = 2;

/**
 * And the ceiling that actually bounds the bill: US dollars of speculation per player turn.
 *
 * A count is the wrong unit on its own, because **a preview is not one model call's worth of
 * work**. Since ALE-32 the game master takes the NPC turns *inside* the preview, on the clone, so
 * in an encounter one speculation pays for the player's staged action and every NPC reaction to
 * it. Out of combat a speculation measured $0.11–$0.14 on `claude-opus-5`; in a fight it is
 * whatever that turn's NPC traffic costs, which is not a number this file can know in advance.
 *
 * So the count cap stops the pointer from making many cheap guesses, and this stops it from making
 * two expensive ones. $0.30 is two measured out-of-combat previews, or one costly in-combat one.
 * The first speculation of a turn always runs — nothing can price a call before making it — so the
 * honest statement of the bound is **at most two, and never a second once the first cost $0.30**.
 */
export const MAX_SPECULATION_USD = 0.3;

/**
 * The GM's own brain policy, re-exported from `ambient.ts` where it now lives: both "whose turn
 * is it in initiative" and "who may stir when nobody is fighting" are questions about the same
 * fact, and one copy of it is the only way they cannot disagree.
 */
export { GM_BRAIN_POLICY };

/** The per-turn speculation budget as it stands. Reported on `/healthz` and asserted in tests. */
export interface SpeculationStats {
  /** The turn these counters belong to; they reset when the room's turn counter moves. */
  turn: number;
  /** Speculative previews started this turn. Never more than `budget`. */
  spent: number;
  /** Speculations the server declined: over budget, stale, one already running, or switched off. */
  dropped: number;
  /** `speculationsPerTurn`. Zero means speculation is off. */
  budget: number;
  /** What those speculations actually cost this turn, and the ceiling that stops the next one. */
  usd: number;
  usdBudget: number;
}

/** What the world has done off its own bat this session. Reported on `/healthz`. */
export interface AmbientStats {
  /** Ambient turns offered — every GO committed outside an encounter. */
  turns: number;
  /** NPC turns actually taken in them. */
  npcTurns: number;
  /** Of those, the ones a saved policy took with no model call (ALE-37's 33 ms path). */
  fromPolicy: number;
}

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
  /**
   * How the ambient world turn is tuned (ALE-41): how near the player has to be to be noticed,
   * how many rounds of standing still count as a beat, and how many NPCs may act in one quiet
   * turn. `ambient.max = 0` switches the feature off without a protocol change.
   */
  ambient?: AmbientOptions;
  /**
   * Speculative previews to pay for per player turn (ALE-40). `0` is the kill switch: the loop
   * still accepts `speculate` frames and still ignores them, so turning it off is a restart and
   * not a protocol change.
   */
  speculationsPerTurn?: number;
  /** Dollars of speculation per player turn. See `MAX_SPECULATION_USD` for why both exist. */
  speculationUsdPerTurn?: number;
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
  /** Handles one `preview_request`, `go` or `speculate` frame. */
  handle(socket: RoomSocket, message: PreviewRequestMessage | GoMessage | SpeculateMessage): void;
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
  /**
   * Cache hits, misses and size, for the meters and for tests. `policies` is the skill cache
   * (ALE-37): a hit is an NPC turn a saved policy took with no model call.
   */
  cache(): { preview: CacheStats; decisions: CacheStats; policies: CacheStats };
  /** Ambient world turns taken this session and how many of them the world answered (ALE-41). */
  ambient(): AmbientStats;
  /** What the pointer has been allowed to spend this turn, and what it was refused (ALE-40). */
  speculation(): SpeculationStats;
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
  const policies = createTurnCache<CachedPolicy>(cacheSize);
  /**
   * Counted here rather than read off `policies.stats()`: a hit is an NPC turn a policy actually
   * *took*, and a lookup that found a program which then failed its turn is a miss however the
   * `Map` felt about it. This is the number ALE-37 is judged on.
   */
  let policyHits = 0;
  let policyMisses = 0;
  /**
   * Policy keys this session has already asked the model about. Writing a policy is not free —
   * the one live resolve in the ALE-37 measurement run cost 33 s against the baseline's 19 s, and
   * the difference is the model writing a program as well as taking a turn. Paying that the first
   * time an NPC acts buys nothing if it never acts again, and on a real ten-turn combat session
   * `resolve` ran exactly once. So the second sighting of the same (NPC, situation) is what buys
   * the policy: it is the earliest evidence that a third turn is coming, and the first turn costs
   * exactly what it cost before this feature existed.
   */
  const seenPolicyKeys = new Set<string>();
  /**
   * The reading each NPC last took an ambient turn on (ALE-41). This is the whole memory the
   * ambient turn has, and it is what keeps it from being a random-number generator: an NPC acts
   * when what it can perceive differs from what it perceived last time it acted, and otherwise
   * stands still. Session state, not world state — nothing here is authoritative, and a replay
   * never consults it, because what it decides is only *who is asked*, never what the world does.
   */
  const ambientSenses = new Map<EntityId, AmbientSense>();
  const ambientOptions: AmbientOptions = options.ambient ?? {};
  const ambientStats: AmbientStats = { turns: 0, npcTurns: 0, fromPolicy: 0 };

  let pending: PendingPreview | null = null;
  let memory: MemoryBlocks = options.memory ?? EMPTY_MEMORY;
  /** One phase at a time. Two overlapping GOs would interleave mutations on one engine. */
  let inFlight: Promise<void> = Promise.resolve();
  let busy = false;
  /** Set when a real frame arrives, so speculation stops between intents instead of racing it. */
  let abandonSpeculation = false;
  const speculationBudget = Math.max(0, options.speculationsPerTurn ?? MAX_SPECULATIONS_PER_TURN);
  const speculationUsd = Math.max(0, options.speculationUsdPerTurn ?? MAX_SPECULATION_USD);
  const freshSpeculation = (turn: number): SpeculationStats => ({
    turn,
    spent: 0,
    dropped: 0,
    budget: speculationBudget,
    usd: 0,
    usdBudget: speculationUsd,
  });
  /** The per-turn spend, and the key of the one speculation allowed to be in the air (ALE-40). */
  let speculation: SpeculationStats = freshSpeculation(-1);
  let speculatingKey: string | null = null;
  let speculationAbort: AbortController | null = null;
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
      /** Why this NPC is stirring, when it is stirring on its own (ALE-41). */
      cue?: string | null;
      wantPolicy?: boolean;
    },
    budgetMs: number,
    onChunk?: (chunk: string) => void,
    /** Cancels the call before its budget is up. Speculation passes one; a real phase does not. */
    cancel?: AbortSignal,
  ): Promise<{
    narration: string;
    calls: GmToolCall[];
    diffs: Diff[];
    failed: string | null;
    /** What the model charged for this call, for the meters (ALE-24). Absent from the stub. */
    usage: Record<string, number> | undefined;
    /** A policy the game master wrote for the acting NPC this turn (ALE-37), if it wrote one. */
    policy: CachedPolicy | null;
  }> => {
    const nothing = { narration: '', calls: [], diffs: [], usage: undefined, policy: null };
    if (!gm) return { ...nothing, failed: 'no game master is configured' };
    try {
      const response = await gm.turn(
        {
          session: room.id,
          turn: room.turn(),
          phase,
          engine_token: body.engineToken,
          state: stateSummary(body.snapshot, body.acting ?? null, body.cue ?? null),
          entities: Object.keys(body.snapshot.entities),
          player_intent: body.intent,
          player_text: body.text,
          memory,
          ...(body.wantPolicy ? { want_policy: true } : {}),
        },
        {
          signal: cancel
            ? AbortSignal.any([AbortSignal.timeout(budgetMs), cancel])
            : AbortSignal.timeout(budgetMs),
          ...(onChunk ? { onChunk } : {}),
        },
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
      const written = response.policy;
      return {
        narration: response.narration,
        calls,
        diffs,
        failed: null,
        usage: response.usage,
        policy: written?.code
          ? { code: written.code, note: written.note ?? '', turn: room.turn() }
          : null,
      };
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
    cancel?: AbortSignal,
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

      // Waiting has nothing to telegraph (ALE-41). A preview exists to show the player what their
      // action would do and what the world would do back; the answer to the first half is "a
      // minute passes", and the second half is the ambient turn itself, which is the surprise the
      // player is buying. Paying a model call to say "you wait" would cost more than everything
      // that follows it. Free text is the exception — a player who *says* something while they
      // wait has asked the game master a question, and that is a real preview.
      if (intent?.kind === 'pass_time' && !text) {
        meter().record(phase, { startedAt, endedAt: Date.now(), cached: true });
        return { text: QUIET_PREVIEW, diffs, calls: [] };
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
        undefined,
        cancel,
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
      // Charged against this turn's dollar ceiling, not just its count: a speculation in a fight
      // pays for the NPC turns the game master took inside it, and those are not free.
      if (phase === 'speculate') speculation.usd += usdFor(tokensFrom(answer.usage));
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
    // Outside an encounter, this is where the world gets its turn (ALE-41). `ambient` is a no-op
    // while initiative is running, so on a combat turn the next two lines cost nothing.
    const fighting = room.engine.snapshot().initiative !== null;
    const stirred = await ambient();
    // The one case where both halves run on one GO, and it is the case worth having: an ambient
    // NPC who drew a weapon. `applyAttack` starts an encounter on the first attack whoever throws
    // it, so a provoked guard opens initiative himself — no new code, and no second way in.
    if (!fighting && room.engine.snapshot().initiative) await resolve();
    // A wait in which nothing stirred has nothing to narrate, and a model call to say so would
    // cost more than the whole turn did. Every other turn narrates as it always has.
    if (staged.intent?.kind !== 'pass_time' || stirred > 0) await narrate(staged);
    // The turn is over and idle: what it cost is settled, and goes to the recording (ALE-24).
    onMeter(meter().finish());
    turnMeter = null;
  };

  // -------------------------------------------------------------------------------------------
  // Resolve — initiative runs, and NPC turns go through the GM
  // -------------------------------------------------------------------------------------------

  /**
   * One NPC turn from the skill cache (ALE-37). `true` when the policy took the turn.
   *
   * The cache holds a program, so a hit is not a lookup — it is an execution, in the GM service's
   * sandbox, whose calls reach the world only through `/gm/tool`. Three things make that safe to
   * put on the critical path of every combat turn:
   *
   * - **It cannot mutate.** A policy proposes; the engine validates, rolls its own dice and
   *   refuses what it does not like, exactly as it does for the model's own calls.
   * - **It cannot hang.** The sandbox kills the process group on its own timeout, and this hop
   *   carries the resolve budget on top of it. Either way the failure is a `false` return.
   * - **It cannot quietly go stale.** A policy that ran fine and landed nothing is a policy whose
   *   situation moved out from under it, so it is retired here and the model is asked instead.
   *   That is the degradation the invalidation story promises: a re-asked turn, never a
   *   wrong-but-accepted one.
   */
  const runPolicy = async (
    snapshot: Snapshot,
    acting: EntityId,
    startedAt: number,
    cue: string | null,
  ): Promise<boolean> => {
    if (!caching || !gm?.policy) return false;
    const key = policyKey(snapshot, acting);
    const program = policies.get(key);
    if (!program) {
      policyMisses += 1;
      return false;
    }

    let served = false;
    try {
      const response = await gm.policy(
        {
          session: room.id,
          turn: room.turn(),
          engine_token: LIVE_ENGINE_TOKEN,
          state: stateSummary(snapshot, acting, cue),
          acting,
          code: program.code,
        },
        { signal: AbortSignal.timeout(resolveBudget) },
      );
      if (!response.ok) log(`${acting}'s policy did not run: ${response.error ?? 'no reason'}`);
      served = response.ok && response.trace.some((e) => e.ok && e.executed !== false);
      if (response.ok && !served) log(`${acting}'s policy landed nothing; retiring it`);
    } catch (error) {
      log(`${acting}'s policy failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!served) {
      policies.delete(key);
      policyMisses += 1;
      return false;
    }
    policyHits += 1;
    // No tokens: `cached` is what the meters call a phase that answered without a model call, and
    // that is exactly what this was.
    meter().record('resolve', { startedAt, endedAt: Date.now(), cached: true });
    return true;
  };

  /**
   * One NPC turn, wherever it came from: initiative, or the world moving on its own (ALE-41).
   *
   * The three-step ladder is the same either way — the exact-world decision cache, then a policy
   * the game master wrote earlier, then the model — because an ambient turn is an NPC turn. What
   * `phase` changes is the task line the service puts in front of the model, and what `cue`
   * changes is whether the model is told why this NPC is stirring at all.
   *
   * Returns whether anything landed. A turn that landed nothing is not "the world acted".
   */
  const npcTurn = async (
    snapshot: Snapshot,
    acting: EntityId,
    phase: 'resolve' | 'ambient',
    cue: string | null,
  ): Promise<boolean> => {
    // The same world and the same NPC is the same question, so the answer is memoised (ALE-22).
    // What comes back is the *plan* — the mutations the game master asked for — and it is replayed
    // through the very same `/gm/tool` door, so the engine validates every call and rolls its own
    // dice afresh. A cached decision can therefore fail where the first one succeeded, which is
    // correct: the cache remembers what an NPC decided to try, never what the world let it do.
    const startedAt = Date.now();
    const key = decisionKey(room.engine.hash(), acting);
    const hit = caching ? decisions.get(key) : undefined;
    if (hit) {
      let landed = false;
      for (const call of hit) {
        if (!replayCall(call)) break;
        landed = true;
      }
      meter().record('resolve', { startedAt, endedAt: Date.now(), cached: true });
      return landed;
    }
    if (await runPolicy(snapshot, acting, startedAt, cue)) {
      if (phase === 'ambient') ambientStats.fromPolicy += 1;
      return true;
    }

    // Neither cache could take the turn, so the model does. Whether it is also asked to write the
    // policy down depends on how likely this situation is to come round again.
    const skill = policyKey(snapshot, acting);
    // In a fight, that is the *second* sighting: writing a program costs real seconds on top of
    // taking the turn, and a real ten-turn combat session reached `resolve` exactly once, so
    // paying it the first time buys nothing. Ambient behaviour is the opposite case and it is why
    // ALE-37 was built: a guard watches a gate every quiet minute of the session, so the third
    // turn is not a guess. Asking on the first sighting pays the writing cost once instead of
    // paying a full model turn and *then* the writing cost.
    const wantPolicy = caching && (phase === 'ambient' || seenPolicyKeys.has(skill));
    seenPolicyKeys.add(skill);
    const answer = await ask(
      phase,
      {
        engineToken: LIVE_ENGINE_TOKEN,
        intent: null,
        text: null,
        snapshot,
        acting,
        cue,
        wantPolicy,
      },
      resolveBudget,
    );
    if (caching && !answer.failed) decisions.set(key, answer.calls);
    // Keyed on the world the policy was *written for*, not the one it leaves behind: the NPC has
    // just acted, so `room.engine.snapshot()` is already a turn out of date for it.
    if (caching && answer.policy) policies.set(skill, answer.policy);
    meter().record('resolve', {
      startedAt,
      endedAt: Date.now(),
      usage: answer.usage,
      failed: answer.failed,
    });
    return answer.calls.length > 0;
  };

  // -------------------------------------------------------------------------------------------
  // Ambient — the world's turn, when nobody is fighting (ALE-41)
  // -------------------------------------------------------------------------------------------

  /**
   * The world gets a turn. Runs after every GO committed outside an encounter, so it is not only
   * the `pass_time` verb that wakes the world: walking up to the gate is itself a thing the guard
   * can notice, and the reaction lands on the same turn that caused it.
   *
   * What makes this affordable is that **most ambient turns cost nothing at all.** `ambientCandidates`
   * is a pure read of the snapshot, and it returns nobody unless an NPC's reading of the world has
   * changed since the last turn it took — so a player crossing empty ground pays for an ambient
   * turn in microseconds, and only a player who did something perceptible pays for a model call.
   * Of the ones that do cost, the second and every one after it should be ALE-37's 33 ms path,
   * because "a merchant idles at a stall" is exactly the repetitive, undramatic behaviour a cached
   * policy is for.
   *
   * Returns how many NPCs actually did something.
   */
  const ambient = async (): Promise<number> => {
    if (!gm) return 0;
    // An encounter has its own answer to "whose turn is it", and it is initiative's.
    if (room.engine.snapshot().initiative) return 0;
    ambientStats.turns += 1;
    let stirred = 0;
    for (const candidate of ambientCandidates(
      room.engine.snapshot(),
      ambientSenses,
      ambientOptions,
    )) {
      // An earlier ambient NPC may have drawn on someone and opened an encounter. From that
      // moment this is initiative's business, and `resolve` picks it up.
      if (room.engine.snapshot().initiative) break;
      // Recorded before the turn, not after: the NPC has now reacted to *this* reading, whatever
      // it chooses to do about it, and reacting twice to one change is the thing to avoid. An NPC
      // crowded out by a nearer neighbour keeps its old reading and stays a candidate next turn.
      ambientSenses.set(candidate.entity, candidate.sense);
      ambientStats.npcTurns += 1;
      if (await npcTurn(room.engine.snapshot(), candidate.entity, 'ambient', candidate.reason)) {
        stirred += 1;
      }
    }
    return stirred;
  };

  const resolve = async (): Promise<void> => {
    for (let i = 0; i < maxNpcTurns; i++) {
      const snapshot = room.engine.snapshot();
      const acting = gmActor(snapshot);
      if (!acting) return;

      if (gm) await npcTurn(snapshot, acting, 'resolve', null);

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

  /**
   * This turn's remaining speculation budget, resetting the counters when the turn has moved on.
   * The turn counter is the natural window: a GO changes the world, so every cached key changes
   * and the guessing starts again from nothing.
   */
  const budgetLeft = (): number => {
    if (speculation.turn !== room.turn()) speculation = freshSpeculation(room.turn());
    return speculation.budget - speculation.spent;
  };

  /**
   * Whether another speculation may be *started*: allowance left on both meters. The dollar meter
   * is the one that matters in a fight, where one speculation pays for every NPC reaction too.
   */
  const affordable = (): boolean => budgetLeft() > 0 && speculation.usd < speculation.usdBudget;

  const drop = (): Promise<void> => {
    budgetLeft();
    speculation.dropped += 1;
    return inFlight;
  };

  const speculate = (intents: (Intent | null)[]): Promise<void> => {
    // Speculation only fills a cache. It stages nothing, sends nothing, and yields to the player,
    // so the worst case of being wrong about what they will pick is a model call nobody used.
    //
    // Everything that can say no says no here, where it is cheap: caching off, no game master, a
    // real phase in the air, one speculation already running, or this turn's pointer having spent
    // its allowance. The client applies the same rules first; this is the copy that counts.
    if (!caching || !gm) return inFlight;
    if (busy || speculatingKey !== null || !affordable()) return drop();
    abandonSpeculation = false;
    const controller = new AbortController();
    speculationAbort = controller;
    speculatingKey = previewKey(room.engine.hash(), intents[0] ?? null, null);
    inFlight = inFlight
      .catch(() => {})
      .then(async () => {
        for (const intent of intents) {
          if (abandonSpeculation || busy || !affordable()) return;
          // Charged before the call, not after: the budget bounds what may be *started*, and a
          // crash between the two would otherwise hand the pointer a free retry.
          speculation.spent += 1;
          const warmed = await computePreview(intent, null, 'speculate', controller.signal);
          // The clone refused it before the game master was ever asked, so it cost nothing and is
          // not charged. Hovering over unreachable ground is how a player reads a map.
          if ('refused' in warmed && speculation.spent > 0) speculation.spent -= 1;
        }
      })
      .catch((error: unknown) => {
        log(`speculation failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        speculatingKey = null;
        speculationAbort = null;
      });
    return inFlight;
  };

  /**
   * A real frame has arrived for `key`. If a speculation is in the air for something else, it is a
   * guess we now know is wrong *and* the player is queued behind it on `inFlight` — so it is
   * cancelled rather than waited out. A speculation for the same key is the win this whole issue
   * is about and is left alone: the player is waiting for exactly that answer.
   */
  const yieldSpeculation = (key: string | null): void => {
    if (speculatingKey !== null && speculatingKey !== key) speculationAbort?.abort();
  };

  return {
    handle(socket, message) {
      if (message.type === 'speculate') {
        // A hint about a pointer, never a request. Anything wrong with it — stale turn, no budget,
        // one already running — is answered with silence: the player asked for nothing, and an
        // error about where they are hovering is noise on a screen that has real errors to show.
        if (message.turn === room.turn()) void speculate([message.intent]);
        else void drop();
        return;
      }
      if (message.turn !== room.turn()) {
        refuse(
          socket,
          `That was composed for turn ${message.turn}; the room is on turn ${room.turn()}.`,
        );
        socket.send(JSON.stringify(room.snapshotMessage()));
        return;
      }
      if (message.type === 'preview_request') {
        yieldSpeculation(previewKey(room.engine.hash(), message.intent, message.text ?? null));
        run(socket, () => preview(socket, message));
      } else {
        // GO commits a preview that already came back; nothing in the air can help it.
        yieldSpeculation(null);
        run(socket, () => go(socket, message));
      }
    },
    pending: () => pending,
    idle: () => inFlight,
    memory: () => memory,
    speculate,
    cache: () => ({
      preview: previews.stats(),
      decisions: decisions.stats(),
      policies: { hits: policyHits, misses: policyMisses, size: policies.stats().size },
    }),
    ambient: () => ({ ...ambientStats }),
    speculation: () => {
      // Rolled forward first, so `/healthz` reports the turn the room is actually on rather than
      // the last one anybody hovered during.
      budgetLeft();
      return { ...speculation };
    },
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
export function stateSummary(
  snapshot: Snapshot,
  acting: EntityId | null,
  /**
   * Why `acting` is stirring, when it is stirring on its own rather than because initiative said
   * so (ALE-41). It is the difference between "an NPC acted" and "an NPC acted *because* the
   * player walked up to it", and the game master cannot narrate the second without being told.
   */
  cue: string | null = null,
): Record<string, unknown> {
  return {
    acting,
    ...(cue ? { cue } : {}),
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

/**
 * What a `pass_time` preview says. Fixed prose rather than a model call: see `computePreview`.
 */
const QUIET_PREVIEW =
  'You hold where you are and let a little time go by. What the world does with it is the world\u2019s business.';

function fallbackPreviewText(intent: Intent | null, failed: string | null): string {
  const what = intent ? `${intent.kind} is legal from here.` : 'Nothing is staged.';
  if (!failed) return what;
  return `${what} No game master narrated it (${failed}).`;
}
