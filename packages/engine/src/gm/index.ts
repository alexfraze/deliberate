/**
 * `src/gm/` — the GM tool contract's engine side (ALE-31).
 *
 * Queries answer from a copy of the snapshot and never touch the RNG; mutations map onto exactly
 * one `Intent` and go through `Engine.apply`. Nothing in here writes to the store directly.
 */

export { executeGmBatch, executeGmTool, toIntent } from './execute.js';
export { applyWorldIntent } from './intents.js';
export {
  getState,
  GmQueryError,
  legalActions,
  lineOfSightQuery,
  pathQuery,
  recall,
  rollPreview,
  type GetStateArgs,
  type GetStateScope,
  type LegalActionsArgs,
  type PathArgs,
  type RecallArgs,
  type RollPreviewArgs,
  type TwoTileArgs,
} from './queries.js';
export { getSpell, SPELLS, SPELL_ACTION } from './spells.js';
export { SUPPORTED_SCHEMA_KEYWORDS, validateAgainstSchema } from './validate.js';
