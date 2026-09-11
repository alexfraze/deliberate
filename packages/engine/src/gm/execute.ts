import {
  gmTool,
  isGmMutationTool,
  isGmQueryTool,
  type EntityId,
  type FlagValue,
  type GmBatchResult,
  type GmToolCall,
  type GmToolResult,
  type Intent,
  type Snapshot,
  type Tile,
} from '@deliberate/protocol';

import type { Engine } from '../engine.js';
import {
  getState,
  legalActions,
  lineOfSightQuery,
  pathQuery,
  recall,
  rollPreview,
  GmQueryError,
  type GetStateArgs,
  type GetStateScope,
  type LegalActionsArgs,
  type PathArgs,
  type RecallArgs,
  type RollPreviewArgs,
  type TwoTileArgs,
} from './queries.js';
import { validateAgainstSchema } from './validate.js';

/**
 * The door the GM comes through (ALE-31). One tool call in, `{ok, reason, diff}` out.
 *
 * The whole point of this module is how little it does. A query is answered from a copy of the
 * snapshot. A mutation is turned into exactly one `Intent` and handed to `Engine.apply` — the
 * same call the player's UI makes, hitting the same validators and emitting the same diffs. There
 * is no path here that writes to the store, so there is no way for a GM tool to do something the
 * player's UI could not, and no way for a rejected call to leave a mark.
 */

/** Execute one tool call against `engine`. Never throws for bad input; it returns a rejection. */
export function executeGmTool(engine: Engine, call: GmToolCall): GmToolResult {
  const definition = gmTool(call.name);
  if (!definition) return rejected(`There is no tool called ${call.name}.`);

  const args = call.args ?? {};
  const reason = validateAgainstSchema(definition.input_schema, args, '');
  if (reason) return rejected(`${call.name}: ${reason}`);

  if (isGmQueryTool(call.name)) {
    try {
      return { ok: true, diff: [], data: runQuery(engine.snapshot(), call.name, args) };
    } catch (e) {
      if (e instanceof GmQueryError) return rejected(`${call.name}: ${e.message}`);
      throw e;
    }
  }

  if (!isGmMutationTool(call.name)) return rejected(`There is no tool called ${call.name}.`);
  const intent = toIntent(call.name, args);
  if (!intent) return rejected(`${call.name}: arguments did not describe an intent.`);
  const verdict = engine.apply(intent);
  return verdict.ok ? { ok: true, diff: verdict.diff } : rejected(verdict.reason);
}

/**
 * A batch stops at the first rejection, so a GM that ignores a verdict cannot carry on building
 * on a world state that never happened. `rejectedAt` says which call stopped it; every call after
 * that one was not attempted, and the engine is in the state the last accepted call left it in.
 */
export function executeGmBatch(engine: Engine, calls: readonly GmToolCall[]): GmBatchResult {
  const results: GmToolResult[] = [];
  for (const [index, call] of calls.entries()) {
    const result = executeGmTool(engine, call);
    results.push(result);
    if (!result.ok) return { results, rejectedAt: index };
  }
  return { results, rejectedAt: null };
}

function rejected(reason: string): GmToolResult {
  return { ok: false, reason, diff: [] };
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

function runQuery(snapshot: Snapshot, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'get_state':
      return getState(snapshot, {
        scope: args['scope'] as GetStateScope,
        entity_id: (args['entity_id'] ?? null) as EntityId | null,
      } satisfies GetStateArgs);
    case 'legal_actions':
      return legalActions(snapshot, { entity_id: args['entity_id'] } as LegalActionsArgs);
    case 'line_of_sight':
      return lineOfSightQuery(snapshot, {
        a: args['a'] as Tile,
        b: args['b'] as Tile,
        map: (args['map'] ?? null) as string | null,
      } satisfies TwoTileArgs);
    case 'path':
      return pathQuery(snapshot, {
        a: args['a'] as Tile,
        b: args['b'] as Tile,
        map: (args['map'] ?? null) as string | null,
        max_cost: args['max_cost'] as number,
      } satisfies PathArgs);
    case 'recall':
      return recall(snapshot, {
        topic: args['topic'] as string,
        limit: args['limit'] as number,
      } satisfies RecallArgs);
    case 'roll_preview':
      return rollPreview(snapshot, { action: args['action'] } as RollPreviewArgs);
    default:
      throw new GmQueryError(`There is no query called ${name}.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Mutations — each tool maps onto exactly one Intent
// ---------------------------------------------------------------------------------------------

/**
 * The mapping table, and the reason the GM cannot invent a mutation: nine tools, nine intents,
 * nothing else. Arguments have already been checked against the tool's schema, so the casts here
 * are reading a shape the validator just confirmed.
 */
export function toIntent(name: string, args: Record<string, unknown>): Intent | null {
  switch (name) {
    case 'move':
      return { kind: 'move', entity: args['entity_id'] as EntityId, to: args['to'] as Tile };
    case 'attack':
      return {
        kind: 'attack',
        attacker: args['attacker'] as EntityId,
        target: args['target'] as EntityId,
        ability: args['ability'] as string,
      };
    case 'cast':
      return {
        kind: 'cast',
        caster: args['entity_id'] as EntityId,
        spell: args['spell'] as string,
        target: args['target'] as EntityId,
      };
    case 'say':
      return {
        kind: 'say',
        speaker: args['npc_id'] as EntityId,
        text: args['text'] as string,
        to: (args['to'] ?? null) as EntityId | null,
      };
    case 'set_disposition':
      return {
        kind: 'set_disposition',
        entity: args['npc_id'] as EntityId,
        toward: args['toward'] as EntityId,
        delta: args['delta'] as number,
        reason: args['reason'] as string,
      };
    case 'spawn':
      return {
        kind: 'spawn',
        template: args['template_id'] as string,
        at: args['at'] as Tile,
        map: (args['map'] ?? null) as string | null,
        id: (args['entity_id'] ?? null) as EntityId | null,
      };
    case 'set_flag':
      return { kind: 'set_flag', key: args['key'] as string, value: args['value'] as FlagValue };
    case 'advance_quest':
      return {
        kind: 'advance_quest',
        quest: args['quest_id'] as string,
        step: args['step'] as number,
      };
    case 'end_turn':
      return { kind: 'end_turn', entity: args['entity_id'] as EntityId };
    default:
      return null;
  }
}
