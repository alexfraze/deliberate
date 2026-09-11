import gmToolContract from '@deliberate/contracts/gm-tools.json' with { type: 'json' };

/**
 * @deliberate/protocol — shared contracts.
 *
 * Everything the engine, server, and client agree on lives here: the state snapshot and its
 * component records, the diff events, player intents, the WebSocket message envelopes, and the
 * shape of a recorded turn. This package holds TYPES AND CONSTANTS ONLY. Behaviour belongs in
 * `@deliberate/engine` (rules), `@deliberate/server` (transport), `@deliberate/client` (render).
 *
 * Source of truth for these shapes is docs/blueprint.md ("Data model", "Game master contract").
 * Changes here are cross-cutting: keep them additive, keep them small, and call them out in the
 * PR description so the other area agents can react. `TODO(ALE-n)` marks the Linear issue whose
 * owner is expected to refine that shape.
 */

// ---------------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------------

export type EntityId = string;
export type RoomId = string;
export type MapId = string;
export type QuestId = string;
export type FactionId = string;

/** Blake2b hex digest over the canonical store, cosmetic fields excluded. See TODO(ALE-8). */
export type StateHash = string;

/** Seed for the engine's deterministic RNG. The engine never calls Math.random. */
export type Seed = string;

/** Bumped when a breaking change lands in any wire shape below. */
export const PROTOCOL_VERSION = 1 as const;

/** The MVP runs one room; the shapes still carry a room id so multiplayer (roadmap P2) is a no-op change. */
export const DEFAULT_ROOM: RoomId = 'main';

// ---------------------------------------------------------------------------------------------
// Space — square grid, 8-way movement, one tile = 5 ft, integer elevation
// ---------------------------------------------------------------------------------------------

export const TILE_FEET = 5 as const;

export type Direction8 = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

/** Integer tile coordinates. Origin top-left, x → east, y → south. */
export interface Tile {
  x: number;
  y: number;
}

/** One cell of a map. TODO(ALE-8): extend (cover, terrain cost, blocks line of sight). */
export interface TileCell {
  elevation: number;
  walkable: boolean;
}

/** A loaded map. `cells` is row-major, length = width * height. */
export interface MapRecord {
  id: MapId;
  width: number;
  height: number;
  cells: TileCell[];
}

// ---------------------------------------------------------------------------------------------
// Entities — component records (blueprint "Data model")
// ---------------------------------------------------------------------------------------------

export interface Position {
  map: MapId;
  x: number;
  y: number;
  facing?: Direction8;
}

/** SRD 5.1 six abilities plus the derived numbers the trimmed rules need. TODO(ALE-9). */
export interface Stats {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
  /** Armor class. */
  ac: number;
  /** Movement speed in feet per turn (30 ft = 6 tiles). */
  speed: number;
  proficiency: number;
}

/** Condition names come from the SRD 5.1 subset the engine implements. TODO(ALE-9): enumerate. */
export type Condition = string;

export interface Health {
  hp: number;
  maxHp: number;
  tempHp?: number;
  conditions: Condition[];
}

export interface ItemStack {
  item: string;
  qty: number;
}

export interface Inventory {
  items: ItemStack[];
}

export interface Faction {
  id: FactionId;
}

/** Engine-owned numbers in [-100, 100], keyed by the entity the disposition is toward. */
export interface Disposition {
  toward: Record<EntityId, number>;
}

/** Policy reference. In M0 only `'player'` and `'none'` exist; the GM (M1) and code brains (P1) come later. */
export interface Brain {
  policy: 'player' | 'none' | (string & {});
}

/** Cosmetic. Excluded from the state hash. */
export interface Dialogue {
  seeds: string[];
}

/** Cosmetic. Excluded from the state hash. */
export interface Portrait {
  asset: string;
}

export interface Components {
  position: Position;
  stats: Stats;
  health: Health;
  inventory: Inventory;
  faction: Faction;
  disposition: Disposition;
  brain: Brain;
  dialogue: Dialogue;
  portrait: Portrait;
}

export type ComponentName = keyof Components;

/**
 * Component names left out of the canonical state hash. Defined now (ALE-8) because the hash keys
 * the preview cache and the NPC-brain cache later; anything that only affects presentation goes here.
 */
export const HASH_EXCLUDED_COMPONENTS: readonly ComponentName[] = ['dialogue', 'portrait'] as const;

export interface Entity {
  id: EntityId;
  name: string;
  components: Partial<Components>;
}

// ---------------------------------------------------------------------------------------------
// World record and snapshot
// ---------------------------------------------------------------------------------------------

export type FlagValue = boolean | number | string;

export interface Quest {
  id: QuestId;
  title: string;
  steps: string[];
  /** Index into `steps`; engine-tracked. */
  step: number;
}

export interface World {
  flags: Record<string, FlagValue>;
  quests: Record<QuestId, Quest>;
  /** In-world clock, in rounds. */
  clock: number;
  maps: Record<MapId, MapRecord>;
}

/**
 * What the acting entity has spent this turn (ALE-9). SRD 5.1 trimmed: one move (up to
 * `Stats.speed` feet, spendable in pieces), one action, one bonus action. Reset when the turn
 * advances. Part of the state hash because it decides which intents are legal.
 */
export interface TurnEconomy {
  /** Feet of movement already used this turn. */
  movedFt: number;
  actionUsed: boolean;
  bonusActionUsed: boolean;
}

/**
 * Turn order for the current encounter; `null` on the snapshot means no encounter is running
 * (exploration: anyone alive may move, nobody may attack until the first attack starts one).
 */
export interface InitiativeState {
  order: EntityId[];
  /** Index into `order` of the entity whose turn it is. */
  current: number;
  round: number;
  /** Economy of the entity at `order[current]`. Absent means a fresh turn (ALE-9 reads it as all-unspent). */
  turn?: TurnEconomy;
}

/** Full authoritative state. The client receives this on join and never mutates it. */
export interface Snapshot {
  schema: typeof PROTOCOL_VERSION;
  entities: Record<EntityId, Entity>;
  world: World;
  initiative: InitiativeState | null;
}

// ---------------------------------------------------------------------------------------------
// Diffs — every engine mutation emits these; apply(snapshot, diffs) must reproduce state (ALE-10)
// ---------------------------------------------------------------------------------------------

export interface EntityMoved {
  type: 'EntityMoved';
  entity: EntityId;
  from: Tile;
  to: Tile;
  /** Tiles stepped through, inclusive of `to`, for the renderer's tween. */
  path: Tile[];
}

export interface DamageApplied {
  type: 'DamageApplied';
  target: EntityId;
  amount: number;
  source: EntityId | null;
  hpAfter: number;
}

export interface ConditionSet {
  type: 'ConditionSet';
  entity: EntityId;
  condition: Condition;
  active: boolean;
}

export interface DialogueLine {
  type: 'DialogueLine';
  speaker: EntityId;
  text: string;
  to: EntityId | null;
}

export interface FlagSet {
  type: 'FlagSet';
  key: string;
  value: FlagValue;
}

export interface EntitySpawned {
  type: 'EntitySpawned';
  entity: Entity;
}

/**
 * Turn order changed: an encounter began, the turn passed to the next entity, or the encounter
 * ended (`initiative: null`). Absolute like every other diff — it carries the whole
 * `InitiativeState`, so folding it twice lands where folding it once did. `world.clock` travels
 * with it because the in-world clock only moves when a turn advance wraps the order into a new
 * round. Added in ALE-13: without it a diff-driven client cannot see whose turn it is.
 */
export interface TurnAdvanced {
  type: 'TurnAdvanced';
  initiative: InitiativeState | null;
  /** `world.clock`, in rounds, after the advance. */
  clock: number;
}

/**
 * The entity whose turn it is spent part of its economy: feet of movement, its action, or its
 * bonus action. `turn` is the whole economy after the spend, not the delta. Added in ALE-13:
 * without it a diff-driven client cannot see what is left to spend.
 */
export interface EconomySpent {
  type: 'EconomySpent';
  entity: EntityId;
  turn: TurnEconomy;
}

/**
 * An entity turned on the spot — an attacker squaring up to its target. A move already carries
 * facing in `EntityMoved.path`; this covers the case where nothing else about the position
 * changed. Added in ALE-13.
 */
export interface FacingChanged {
  type: 'FacingChanged';
  entity: EntityId;
  facing: Direction8;
}

/**
 * One entity's feeling toward another moved. Absolute like every other diff: `value` is where the
 * number landed after clamping to [-100, 100], not the delta that was asked for. `reason` is the
 * GM's one-line justification, carried so the verified ledger can quote why the world changed.
 * Added in ALE-31: `set_disposition` mutates state, so it needs a diff or `apply(snapshot, diffs)`
 * stops reproducing the engine.
 */
export interface DispositionChanged {
  type: 'DispositionChanged';
  entity: EntityId;
  toward: EntityId;
  /** Disposition after the change, in [-100, 100]. */
  value: number;
  reason: string;
}

/**
 * A quest moved to a later step. Absolute: `step` is the index the quest is on now. Added in
 * ALE-31 for the same reason as `DispositionChanged`.
 */
export interface QuestAdvanced {
  type: 'QuestAdvanced';
  quest: QuestId;
  step: number;
}

export type Diff =
  | EntityMoved
  | DamageApplied
  | ConditionSet
  | DialogueLine
  | FlagSet
  | EntitySpawned
  | TurnAdvanced
  | EconomySpent
  | FacingChanged
  | DispositionChanged
  | QuestAdvanced;

export type DiffType = Diff['type'];

export const DIFF_TYPES: readonly DiffType[] = [
  'EntityMoved',
  'DamageApplied',
  'ConditionSet',
  'DialogueLine',
  'FlagSet',
  'EntitySpawned',
  'TurnAdvanced',
  'EconomySpent',
  'FacingChanged',
  'DispositionChanged',
  'QuestAdvanced',
] as const;

// ---------------------------------------------------------------------------------------------
// Intents — what the player (M0) or the GM's validated tool calls (M1) ask the engine to do
// ---------------------------------------------------------------------------------------------

export interface MoveIntent {
  kind: 'move';
  entity: EntityId;
  to: Tile;
}

export interface AttackIntent {
  kind: 'attack';
  attacker: EntityId;
  target: EntityId;
  /** Weapon or ability key; the engine resolves it against the trimmed SRD tables. TODO(ALE-9). */
  ability: string;
}

export interface EndTurnIntent {
  kind: 'end_turn';
  entity: EntityId;
}

/**
 * Cast an attack cantrip. Resolves through the same validated pipeline as a weapon attack —
 * range, line of sight, action economy, a seeded attack roll — with the spell in place of the
 * weapon. Added in ALE-31 for the GM's `cast` tool.
 */
export interface CastIntent {
  kind: 'cast';
  caster: EntityId;
  /** Spell key from the trimmed cantrip table. */
  spell: string;
  target: EntityId;
}

/**
 * An entity speaks. The one intent that mutates nothing: it emits a `DialogueLine` and leaves the
 * state hash exactly where it was. It is still validated (an unknown or dead speaker is
 * rejected), because the GM must not be able to put words in a corpse's mouth. Added in ALE-31.
 */
export interface SayIntent {
  kind: 'say';
  speaker: EntityId;
  text: string;
  /** Who is addressed; `null` speaks to the room. */
  to: EntityId | null;
}

/** Move `entity`'s disposition toward another by `delta`, clamped to [-100, 100]. ALE-31. */
export interface SetDispositionIntent {
  kind: 'set_disposition';
  entity: EntityId;
  toward: EntityId;
  delta: number;
  /** Why, in one short phrase. Travels with the diff into the verified ledger. */
  reason: string;
}

/** Place a new entity built from a known template. ALE-31. */
export interface SpawnIntent {
  kind: 'spawn';
  /** Key into the template registry the engine was configured with (`EngineOptions.templates`). */
  template: string;
  at: Tile;
  /** Map to place it on; `null` means the only loaded map. */
  map: MapId | null;
  /** Id for the new entity; `null` derives a unique one from the template key. */
  id: EntityId | null;
}

/** Set a world flag. ALE-31. */
export interface SetFlagIntent {
  kind: 'set_flag';
  key: string;
  value: FlagValue;
}

/** Move a quest strictly forward to `step`. ALE-31. */
export interface AdvanceQuestIntent {
  kind: 'advance_quest';
  quest: QuestId;
  step: number;
}

/**
 * Everything the engine can be asked to do. M0 shipped `move`, `attack` and `end_turn`; ALE-31
 * added the rest for the GM's mutation tools. The addition is additive: each new kind is a new
 * member of the union, no existing member changed, and every GM mutation tool maps onto exactly
 * one of these — a tool call is not a second way into the store, it is the same validated path
 * the player's UI uses.
 */
export type Intent =
  | MoveIntent
  | AttackIntent
  | EndTurnIntent
  | CastIntent
  | SayIntent
  | SetDispositionIntent
  | SpawnIntent
  | SetFlagIntent
  | AdvanceQuestIntent;

export type IntentKind = Intent['kind'];

/**
 * Result of asking the engine to apply a mutation. Blueprint: `{ok, reason, diff}`.
 * A rejected mutation never touches state; `diff` is empty and `reason` is player-visible.
 */
export type Verdict =
  { ok: true; reason?: undefined; diff: Diff[] } | { ok: false; reason: string; diff: [] };

// ---------------------------------------------------------------------------------------------
// WebSocket turn protocol (ALE-11). Documented for humans in docs/protocol.md.
// ---------------------------------------------------------------------------------------------

/** First message from the client. Not in the ALE-11 list, but the client must obtain a snapshot (ALE-12). */
export interface JoinMessage {
  type: 'join';
  room: RoomId;
  protocol: typeof PROTOCOL_VERSION;
}

export interface IntentMessage {
  type: 'intent';
  room: RoomId;
  /** The turn the client composed this intent against; the server rejects stale intents. */
  turn: number;
  intent: Intent;
}

/**
 * Ask for a speculative turn (ALE-32). The server clones the engine, lets the GM act on the
 * clone, and replies with a `preview`. **Nothing is committed**: the real engine is byte-identical
 * before and after. Send it again to change your mind; the last preview is the one `go` commits.
 */
export interface PreviewRequestMessage {
  type: 'preview_request';
  room: RoomId;
  /** The turn the preview was composed against; a stale one is refused like a stale intent. */
  turn: number;
  /** The intent the UI composed, or `null` to ask only what the world does. */
  intent: Intent | null;
  /** Free player text. It reaches the GM as quoted data, never as instruction (ALE-33). */
  text?: string;
}

/**
 * Commit the last preview (ALE-32). The server re-validates the player's intent and every
 * previewed GM call against the REAL engine before applying them — the preview ran on a clone and
 * its verdicts are not evidence — then resolves initiative and narrates.
 */
export interface GoMessage {
  type: 'go';
  room: RoomId;
  turn: number;
}

export type ClientMessage = JoinMessage | IntentMessage | PreviewRequestMessage | GoMessage;

/** Reply to `join`: the authoritative state and its hash. */
export interface SnapshotMessage {
  type: 'snapshot';
  room: RoomId;
  turn: number;
  snapshot: Snapshot;
  hash: StateHash;
}

/** Speculative resolution of an intent before GO. Empty of diffs in M0 (no model yet). */
export interface PreviewMessage {
  type: 'preview';
  room: RoomId;
  turn: number;
  text: string;
  diffs: Diff[];
}

/** Committed diffs for a turn, plus the hash the client can echo back for consistency checks. */
export interface DiffsMessage {
  type: 'diffs';
  room: RoomId;
  turn: number;
  diffs: Diff[];
  hash: StateHash;
}

/** Streamed narration chunks. Unused in M0; the shape exists so M1 does not change the protocol. */
export interface NarrationMessage {
  type: 'narration';
  room: RoomId;
  turn: number;
  chunk: string;
  done: boolean;
}

/** Rejections carry the engine's reason so the UI can show why an action was illegal (ALE-13). */
export interface ErrorMessage {
  type: 'error';
  room: RoomId;
  turn: number | null;
  reason: string;
}

export type ServerMessage =
  SnapshotMessage | PreviewMessage | DiffsMessage | NarrationMessage | ErrorMessage;

export type ServerMessageType = ServerMessage['type'];

// ---------------------------------------------------------------------------------------------
// Session recording — one JSONL line per turn, replayable with the engine alone (ALE-30)
// ---------------------------------------------------------------------------------------------

/** GM tool calls with their engine verdicts. Always empty in M0. */
export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  verdict: Verdict;
}

export interface RecordingHeader {
  line: 'header';
  protocol: typeof PROTOCOL_VERSION;
  room: RoomId;
  seed: Seed;
  startedAt: string;
  snapshot: Snapshot;
  hash: StateHash;
  /**
   * Entity templates the session's engine was built with (`EngineOptions.templates`). A snapshot
   * and a seed are not quite the whole engine: `spawn` reads the template table, so a session in
   * which the GM spawned — or was refused because a template was missing — only replays if the
   * replay engine is given the same table. Optional and omitted when empty, so every recording
   * written before ALE-21 replays exactly as it did before.
   */
  templates?: Record<string, Entity>;
}

export interface RecordedTurn {
  line: 'turn';
  turn: number;
  hashBefore: StateHash;
  intent: Intent;
  toolCalls: ToolCallRecord[];
  verdict: Verdict;
  diffs: Diff[];
  hashAfter: StateHash;
  tokens: { input: number; output: number };
  latencyMs: { preview: number; validate: number; resolve: number; narrate: number };
}

export type RecordingLine = RecordingHeader | RecordedTurn;

// ---------------------------------------------------------------------------------------------
// Save files (ALE-23) — one JSON document that a restarted server can resume from
// ---------------------------------------------------------------------------------------------

/**
 * Bumped when the layout below changes in a way an older loader would misread. It is a separate
 * number from `PROTOCOL_VERSION` because a save outlives a process, so it is the one artefact
 * where "silently read the wrong thing" is a real risk: a file whose `save` is not this number is
 * refused rather than guessed at. Database persistence is roadmap P2 (ALE-26); this is JSON.
 */
export const SAVE_VERSION = 1 as const;

/**
 * A whole session in one JSON document: the store, the world record, the GM's memory blocks, and
 * — the part that is easy to forget — where the seeded RNG had got to.
 *
 * Restoring the snapshot alone restores the state hash but not the *future*: `createRng` would
 * start the stream again from the seed, so the next attack roll after a load would be a roll the
 * uninterrupted session had already spent. `rngCalls` is what makes a resumed session continue
 * the same sequence, and therefore what makes it replay.
 */
export interface SaveFile {
  /** Discriminator and version in one. See `SAVE_VERSION`. */
  save: typeof SAVE_VERSION;
  protocol: typeof PROTOCOL_VERSION;
  /** ISO-8601 wall clock, for a human choosing between files. Not part of the restored state. */
  savedAt: string;
  room: RoomId;
  /** The turn the room was accepting intents for, so turn numbers continue rather than restart. */
  turn: number;
  seed: Seed;
  /** How many numbers the seeded RNG had drawn. A load resumes the stream at this position. */
  rngCalls: number;
  /** Scene the world was booted from, so the GM's `spawn` templates come back. `null` if unknown. */
  scene: string | null;
  /** The full store, cosmetic components included: a load must look right as well as hash right. */
  snapshot: Snapshot;
  /** The hash at save time. A load checks what it rebuilt against this and refuses a mismatch. */
  hash: StateHash;
  /**
   * The GM's memory blocks exactly as the service handed them back (ALE-15). Opaque here for the
   * same reason as in the server: the shape lives in Python, and a second copy of it would drift.
   */
  memory: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// GM tool contract (ALE-31)
// ---------------------------------------------------------------------------------------------

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

/**
 * One entry of the contract. `name`, `description` and `input_schema` are the three keys the
 * Anthropic `tools` parameter takes; `kind` is contract metadata that loaders drop when building
 * that parameter.
 *
 * `kind` is the free-vs-validated distinction, and it lives in the file so that neither language
 * has to keep a hardcoded list of which tools mutate. Adding a tool is then a one-file change.
 */
export interface GmToolDefinition {
  name: string;
  /** `query`: free, read-only, never consumes the RNG. `mutation`: maps onto exactly one Intent. */
  kind: 'query' | 'mutation';
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
  tools: readonly GmToolDefinition[];
};

export const GM_CONTRACT_VERSION: number = contract.version;

/**
 * Every tool in file order — queries first, then mutations. This is the array the model sees, and
 * the order is the head of the cached prompt prefix, so it must stay stable.
 */
export const GM_TOOLS: readonly GmToolDefinition[] = contract.tools;

export const GM_QUERY_TOOLS: readonly GmToolDefinition[] = GM_TOOLS.filter(
  (t) => t.kind === 'query',
);
export const GM_MUTATION_TOOLS: readonly GmToolDefinition[] = GM_TOOLS.filter(
  (t) => t.kind === 'mutation',
);

export function gmTool(name: string): GmToolDefinition | undefined {
  return GM_TOOLS.find((t) => t.name === name);
}

/**
 * Both guards answer from the contract's own `kind`, never from a list kept alongside it. The
 * name tuples above exist for the literal types; `gm.test.ts` asserts they still agree with the
 * file, so a tool added to the JSON alone fails the build rather than going quietly unhandled.
 */
export function isGmQueryTool(name: string): name is GmQueryToolName {
  return gmTool(name)?.kind === 'query';
}

export function isGmMutationTool(name: string): name is GmMutationToolName {
  return gmTool(name)?.kind === 'mutation';
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
