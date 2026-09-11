import gmToolContract from '@deliberate/contracts/gm-tools.json' with { type: 'json' };

import type { Diff } from './index.js';

/**
 * The GM tool contract (ALE-31).
 *
 * `contracts/gm-tools.json` is the single source of truth for the tool schemas: this module
 * imports it, the Python GM service loads the same file and passes the entries straight to the
 * Anthropic `tools` parameter. There is no second copy and no codegen step, so the two languages
 * cannot drift (decision 2 of docs/m1-swarm.md).
 *
 * What lives here is the typing over that JSON plus the call/result envelopes. The engine
 * (`@deliberate/engine`, `src/gm/`) validates an incoming call against the schema, maps it to
 * exactly one `Intent`, and returns the engine's own `Verdict`. A GM tool call is not a new
 * mutation path — it is the same validated path the player's UI already uses.
 */

// ---------------------------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------------------------

/**
 * The subset of JSON Schema the contract uses, which is also the subset the engine's argument
 * validator understands: objects with fixed properties, primitives, enums, bounds, and unions
 * expressed as a list of type names (`["string", "null"]` for a nullable argument).
 */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: readonly (string | number | boolean | null)[];
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

/** One entry of the Anthropic `tools` array. Exactly these three keys; nothing to strip. */
export interface GmToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

/**
 * Query tools: free, read-only, and never consume the seeded RNG. `roll_preview` reports odds
 * computed from the rules rather than rolling, so asking for odds cannot change the next roll.
 */
export const GM_QUERY_TOOL_NAMES = [
  'get_state',
  'legal_actions',
  'line_of_sight',
  'path',
  'recall',
  'roll_preview',
] as const;

/** Mutation tools. Each maps onto exactly one `Intent` and is validated by the engine. */
export const GM_MUTATION_TOOL_NAMES = [
  'move',
  'attack',
  'cast',
  'say',
  'set_disposition',
  'spawn',
  'set_flag',
  'advance_quest',
  'end_turn',
] as const;

export type GmQueryToolName = (typeof GM_QUERY_TOOL_NAMES)[number];
export type GmMutationToolName = (typeof GM_MUTATION_TOOL_NAMES)[number];
export type GmToolName = GmQueryToolName | GmMutationToolName;

/**
 * The parsed contract. The cast is the one place the JSON meets the type system; `gm.test.ts`
 * asserts the file really has this shape and that its names match the tuples above, so the cast
 * cannot quietly become a lie.
 */
const contract = gmToolContract as unknown as {
  version: number;
  queries: readonly GmToolDefinition[];
  mutations: readonly GmToolDefinition[];
};

export const GM_CONTRACT_VERSION: number = contract.version;
export const GM_QUERY_TOOLS: readonly GmToolDefinition[] = contract.queries;
export const GM_MUTATION_TOOLS: readonly GmToolDefinition[] = contract.mutations;

/** Every tool, queries first — the array to hand to the model. */
export const GM_TOOLS: readonly GmToolDefinition[] = [...GM_QUERY_TOOLS, ...GM_MUTATION_TOOLS];

export function isGmQueryTool(name: string): name is GmQueryToolName {
  return (GM_QUERY_TOOL_NAMES as readonly string[]).includes(name);
}

export function isGmMutationTool(name: string): name is GmMutationToolName {
  return (GM_MUTATION_TOOL_NAMES as readonly string[]).includes(name);
}

export function gmTool(name: string): GmToolDefinition | undefined {
  return GM_TOOLS.find((t) => t.name === name);
}

// ---------------------------------------------------------------------------------------------
// Call and result envelopes
// ---------------------------------------------------------------------------------------------

/**
 * One tool call from the GM. `args` is whatever the model produced: untrusted until the engine
 * has checked it against `input_schema`. `id` is the model's tool_use id when there is one, so
 * the service can pair results back up.
 */
export interface GmToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

/**
 * The answer to one tool call, shaped like the engine's `Verdict` ({ok, reason, diff}) so a
 * mutation's verdict passes through unchanged and a recording line needs no translation.
 * Queries answer `ok: true` with an empty `diff` and their payload in `data`; mutations answer
 * with the engine's diffs and no `data`. A rejection carries a reason a player could read and,
 * by the engine's contract, left the world untouched.
 */
export type GmToolResult =
  | { ok: true; reason?: undefined; diff: Diff[]; data?: unknown }
  | { ok: false; reason: string; diff: []; data?: undefined };

/** A batch of calls stops at the first rejection, so `results` may be shorter than `calls`. */
export interface GmBatchResult {
  results: GmToolResult[];
  /** Index of the call that was rejected, or null when every call succeeded. */
  rejectedAt: number | null;
}
