import type { Diff, EntityId, Intent } from '@deliberate/protocol';

/**
 * The Node side of `POST /turn` (docs/gm-service.md): the GM service as this package needs to see
 * it, plus an HTTP implementation of it.
 *
 * The interface exists so the turn loop can be built and tested with no credentials and no Python
 * (decision 6 of docs/m1-swarm.md). `stub.ts` implements it with a scripted fake; `httpGmService`
 * implements it against the real service. The loop cannot tell them apart, which is the point:
 * what ALE-17 adds is a URL, not a code path.
 *
 * Memory blocks are **opaque here**. The service owns their shape (ALE-15); Node's whole job is to
 * hand back what it was given last turn. Typing them structurally would be a second copy of a
 * contract that lives in Python, and it would drift.
 */

export type GmPhase = 'preview' | 'resolve' | 'narrate';

/** Whatever `MemoryBlocks` the GM service returned last turn. Node persists it and replays it. */
export type MemoryBlocks = Record<string, unknown>;

export const EMPTY_MEMORY: MemoryBlocks = {};

export interface GmTurnRequest {
  session: string;
  turn: number;
  phase: GmPhase;
  /** Which engine `/gm/tool` calls act on. The clone's token during a preview (decision 5). */
  engine_token: string | null;
  /** A read-only state summary. Not authoritative: the engine answers `get_state` for the truth. */
  state: Record<string, unknown>;
  /** Entity ids the world-model memory block may reference; ALE-15 drops notes about anyone else. */
  entities: EntityId[];
  /** The intent the UI composed. The engine still validates it. */
  player_intent: Intent | null;
  /** Free player text. Quoted data in the prompt, never instruction (ALE-33). */
  player_text: string | null;
  memory: MemoryBlocks;
  max_tool_steps?: number;
}

/** One entry of the GM's trace. Field names are the service's (`docs/gm-service.md`). */
export interface GmToolCallRecord {
  call_id?: string | null;
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  kind?: 'query' | 'mutation';
  reason?: string | null;
  diff?: Diff[];
  result?: unknown;
  /** False marks a call the batch-stop discipline skipped after an earlier rejection. */
  executed?: boolean;
  latency_ms?: number;
}

export interface GmTurnResponse {
  narration: string;
  trace: GmToolCallRecord[];
  stop_reason: string;
  memory: MemoryBlocks;
  usage?: Record<string, number>;
  prompt_tokens_estimate?: number;
  /** A reusable NPC policy the game master wrote this turn, if it wrote one (ALE-37). */
  policy?: GmPolicyProgram | null;
}

/** A policy program as the service hands it back. Node decides what to key it on; see `cache.ts`. */
export interface GmPolicyProgram {
  code: string;
  note?: string;
}

/**
 * `POST /policy` — run a saved policy for one NPC turn, with no model in the loop (ALE-37).
 *
 * Same discipline as `/turn`: `state` is the summary the engine already computed, and
 * `engine_token` names the engine the policy's calls act on. The service still holds no world
 * state and does not remember the policy between requests — Node owns the skill cache.
 */
export interface GmPolicyRequest {
  session: string;
  turn: number;
  engine_token: string | null;
  state: Record<string, unknown>;
  /** The entity whose turn the policy is taking. */
  acting: EntityId;
  code: string;
}

export interface GmPolicyResponse {
  /**
   * Whether the *program* ran. `false` means it raised or was killed for running too long — never
   * that the engine refused something, which is an ordinary verdict on an ordinary trace line.
   */
  ok: boolean;
  error?: string | null;
  trace: GmToolCallRecord[];
  stdout?: string;
}

export interface GmTurnOptions {
  /** Called as narration arrives, so the client sees prose before the turn is finished. */
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
}

/**
 * What the service's own `/healthz` says about itself. Only the fields anything outside this
 * package needs: which model runs a turn, which one narrates, and whether it has credentials.
 */
export interface GmHealth {
  model: string | null;
  narrateModel: string | null;
  liveApi: boolean;
}

export interface GmService {
  turn(request: GmTurnRequest, options?: GmTurnOptions): Promise<GmTurnResponse>;
  /**
   * The service's own `/healthz`, or null when it did not answer. Optional, because the scripted
   * stub has no HTTP behind it. `/healthz` here reports the result so the client can say on screen
   * whether a model is actually in the loop (ALE-39) instead of leaving the player to infer it.
   */
  health?(): Promise<GmHealth | null>;
  /**
   * Runs a policy the game master wrote earlier (ALE-37). The expensive half of an NPC turn was a
   * Claude call; this is a sandboxed subprocess and a few localhost round trips instead.
   */
  policy(request: GmPolicyRequest, options?: GmTurnOptions): Promise<GmPolicyResponse>;
}

export interface HttpGmServiceOptions {
  /** Base URL of the Python service, e.g. `http://127.0.0.1:8788`. */
  baseUrl: string;
  /**
   * Hard ceiling on one `/turn` call. A turn loop that never returns would hang the room, so every
   * request carries a timeout; the blueprint's phase budgets are what the caller passes in.
   */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export const DEFAULT_GM_TIMEOUT_MS = 20_000;

/** A health probe is answered from memory by the service, so it gets a much shorter leash. */
export const GM_HEALTH_TIMEOUT_MS = 2_000;

/**
 * The real client. Non-streaming: the service streams from the model, but this hop returns once,
 * and `onChunk` is called with the finished narration. Server-sent events over this hop are the
 * obvious next step and are deliberately not in M1 — the interface already has the seam for it.
 */
export function httpGmService(options: HttpGmServiceOptions): GmService {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GM_TIMEOUT_MS;
  const base = options.baseUrl.replace(/\/$/, '');
  const url = `${base}/turn`;

  const post = async (
    path: string,
    body: unknown,
    callOptions?: GmTurnOptions,
  ): Promise<unknown> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = callOptions?.signal ? AbortSignal.any([timeout, callOptions.signal]) : timeout;
    const response = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new GmServiceError(`the game master answered ${response.status}`, response.status);
    }
    return response.json();
  };

  return {
    async policy(request, callOptions) {
      return (await post('/policy', request, callOptions)) as GmPolicyResponse;
    },
    async health() {
      try {
        const response = await doFetch(`${base}/healthz`, {
          signal: AbortSignal.timeout(GM_HEALTH_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as Record<string, unknown>;
        const text = (key: string): string | null =>
          typeof body[key] === 'string' ? body[key] : null;
        return {
          model: text('model'),
          narrateModel: text('narrate_model'),
          liveApi: body['live_api'] === true,
        };
      } catch {
        // Unreachable is a fact about the world, not an error to propagate: `/healthz` says so.
        return null;
      }
    },
    async turn(request, callOptions) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = callOptions?.signal ? AbortSignal.any([timeout, callOptions.signal]) : timeout;
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      });
      if (!response.ok) {
        throw new GmServiceError(`the game master answered ${response.status}`, response.status);
      }
      const body = (await response.json()) as GmTurnResponse;
      if (body.narration) callOptions?.onChunk?.(body.narration);
      return body;
    },
  };
}

export class GmServiceError extends Error {
  override readonly name = 'GmServiceError';
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}
