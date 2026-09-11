import { executeGmTool, type Engine } from '@deliberate/engine';
import {
  gmTool,
  type Diff,
  type GmToolCall,
  type StateHash,
  type Verdict,
} from '@deliberate/protocol';

import type { Room } from '../room.js';
import { LIVE_ENGINE_TOKEN, type EngineHandle, type EngineRegistry } from './engines.js';

/**
 * `POST /gm/tool` — the only door into the engine for the game master (decision 1 of
 * docs/m1-swarm.md). One tool call in, `{ok, kind, reason, diff, result, state_hash}` out.
 *
 * Everything arriving here is untrusted: it came off a socket from a process that is running a
 * language model. So the body is checked field by field before anything is done with it, and the
 * call itself is checked a second time by `executeGmTool`, which validates the arguments against
 * `contracts/gm-tools.json` and then hands the resulting intent to `Engine.apply`. There is no
 * path through this module that writes to a store: a mutation is an `Intent`, and an `Intent` is
 * the same validated road the player's UI travels.
 *
 * Queries are free and read-only. Mutations on the live engine go through the room, so they
 * broadcast their diffs to every client and land in the recording beside the tool call that asked
 * for them. Mutations on a clone go nowhere but the clone.
 */

/** The request body, after validation. Mirrors docs/gm-service.md "Python → Node". */
export interface GmToolRequest {
  session: string | null;
  turn: number | null;
  engineToken: string | null;
  callId: string | null;
  tool: string;
  input: Record<string, unknown>;
}

/** The response body. `kind` defaults to `mutation`, so an unclassified call is recorded, not lost. */
export interface GmToolResponse {
  ok: boolean;
  kind: 'query' | 'mutation';
  reason: string | null;
  diff: Diff[];
  result: unknown;
  state_hash: StateHash | null;
}

export type ParsedGmToolRequest =
  { ok: true; request: GmToolRequest } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

/**
 * Type guards over the wire body. Deliberately permissive about the bookkeeping fields (`session`,
 * `turn`, `call_id` are for the recording, not for control flow) and strict about the two that
 * decide what happens: `tool` must be a string and `input` must be an object. Whether the tool
 * exists and whether the arguments fit its schema is the engine's answer, not this function's.
 */
export function parseGmToolRequest(body: unknown): ParsedGmToolRequest {
  if (!isRecord(body)) return { ok: false, reason: 'The request body must be a JSON object.' };
  const tool = body['tool'];
  if (typeof tool !== 'string' || tool.length === 0 || tool.length > 128) {
    return { ok: false, reason: 'A tool call must name a tool.' };
  }
  const input = body['input'] ?? {};
  if (!isRecord(input)) return { ok: false, reason: `${tool}: input must be a JSON object.` };
  const turn = body['turn'];
  return {
    ok: true,
    request: {
      session: optionalString(body['session']),
      turn: Number.isInteger(turn) ? (turn as number) : null,
      engineToken: optionalString(body['engine_token']),
      callId: optionalString(body['call_id']),
      tool,
      input,
    },
  };
}

export interface GmToolDeps {
  registry: EngineRegistry;
  /** Present for the live engine only: mutations go through it so they broadcast and record. */
  room?: Room;
}

function refuse(reason: string, kind: 'query' | 'mutation' = 'mutation'): GmToolResponse {
  return { ok: false, kind, reason, diff: [], result: null, state_hash: null };
}

/**
 * Executes one validated request. Pure in the sense that matters: it is the same function the
 * HTTP route calls and the same one the stub GM calls, so a test that drives the stub is
 * exercising the real door rather than a sympathetic imitation of it.
 */
export function executeGmToolRequest(deps: GmToolDeps, request: GmToolRequest): GmToolResponse {
  const kind = gmTool(request.tool)?.kind ?? 'mutation';
  const handle = deps.registry.get(request.engineToken);
  if (!handle) {
    return refuse(
      `No engine called ${request.engineToken ?? LIVE_ENGINE_TOKEN} is open; the preview it belonged to is over.`,
      kind,
    );
  }

  if (handle.live && kind === 'mutation') {
    const sealed = deps.registry.sealed();
    if (sealed) return refuse(sealed, kind);
  }

  const call: GmToolCall = {
    name: request.tool,
    args: request.input,
    ...(request.callId ? { id: request.callId } : {}),
  };
  const result = executeGmTool(engineFor(deps, handle, call), call);
  return {
    ok: result.ok,
    kind,
    reason: result.ok ? null : result.reason,
    diff: result.diff,
    result: result.ok ? (result.data ?? null) : null,
    state_hash: handle.engine.hash(),
  };
}

/**
 * The live engine is presented to `executeGmTool` as an `Engine` whose `apply` goes through the
 * room. That is the whole trick: the GM code path is identical for a clone and for the real world,
 * and the difference — broadcast and record, or neither — lives in one substitution here instead
 * of in a branch inside the execution logic where it could be forgotten.
 */
function engineFor(deps: GmToolDeps, handle: EngineHandle, call: GmToolCall): Engine {
  const room = deps.room;
  if (!handle.live || !room) return handle.engine;
  return {
    snapshot: () => handle.engine.snapshot(),
    hash: () => handle.engine.hash(),
    apply: (intent): Verdict => room.commitGmCall(intent, call),
  };
}
