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

/** Turn order for the current encounter. TODO(ALE-9). */
export interface InitiativeState {
  order: EntityId[];
  /** Index into `order` of the entity whose turn it is. */
  current: number;
  round: number;
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

export type Diff =
  EntityMoved | DamageApplied | ConditionSet | DialogueLine | FlagSet | EntitySpawned;

export type DiffType = Diff['type'];

export const DIFF_TYPES: readonly DiffType[] = [
  'EntityMoved',
  'DamageApplied',
  'ConditionSet',
  'DialogueLine',
  'FlagSet',
  'EntitySpawned',
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

/** M0 intents. M1 adds `say` and free text (quoted as data, never as instruction). */
export type Intent = MoveIntent | AttackIntent | EndTurnIntent;

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

export type ClientMessage = JoinMessage | IntentMessage;

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
