/**
 * `src/gm/` — the server's half of the game master (ALE-32).
 *
 * `POST /gm/tool` is the only door into the engine for the GM (decision 1 of docs/m1-swarm.md);
 * `loop.ts` is the Deliberate → Preview → GO → Resolve → Narrate turn loop, and preview runs on a
 * clone so the real engine is untouched until GO (decision 5).
 */

export {
  createTurnCache,
  decisionKey,
  policyKey,
  previewKey,
  stanceOf,
  DEFAULT_CACHE_SIZE,
  type CacheStats,
  type CachedDecision,
  type CachedPolicy,
  type CachedPreview,
  type Stance,
  type TurnCache,
} from './cache.js';
export {
  ambientCandidates,
  describeChange,
  playerOf,
  proximityOf,
  senseOf,
  AMBIENT_ADJACENT_FT,
  AMBIENT_IDLE_ROUNDS,
  AMBIENT_NOTICE_FT,
  GM_BRAIN_POLICY,
  MAX_AMBIENT_ACTORS,
  type AmbientCandidate,
  type AmbientOptions,
  type AmbientSense,
  type Proximity,
} from './ambient.js';
export {
  createEngineRegistry,
  LIVE_ENGINE_TOKEN,
  type EngineHandle,
  type EngineRegistry,
  type EngineRegistryOptions,
} from './engines.js';
export {
  createGmLoop,
  gmActor,
  stateSummary,
  NARRATE_BUDGET_MS,
  PREVIEW_BUDGET_MS,
  RESOLVE_BUDGET_MS,
  type AmbientStats,
  type GmLoop,
  type GmLoopOptions,
  type PendingPreview,
} from './loop.js';
export {
  createMeters,
  tokensFrom,
  usdFor,
  PRICE_PER_MTOK,
  type MeteredPhase,
  type Meters,
  type PhaseReport,
  type TokenCounts,
  type TurnMeter,
  type TurnMeters,
} from './meters.js';
export {
  httpGmService,
  GmServiceError,
  DEFAULT_GM_TIMEOUT_MS,
  EMPTY_MEMORY,
  type GmPhase,
  type GmPolicyProgram,
  type GmPolicyRequest,
  type GmPolicyResponse,
  type GmService,
  type GmToolCallRecord,
  type GmTurnOptions,
  type GmTurnRequest,
  type GmTurnResponse,
  type HttpGmServiceOptions,
  type MemoryBlocks,
} from './service.js';
export {
  stubGmService,
  type GmScript,
  type PolicyScript,
  type ScriptedCall,
  type ScriptedTurn,
} from './stub.js';
export {
  executeGmToolRequest,
  parseGmToolRequest,
  type GmToolDeps,
  type GmToolRequest,
  type GmToolResponse,
  type ParsedGmToolRequest,
} from './tool.js';
