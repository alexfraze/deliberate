/**
 * @deliberate/npcs — M1 NPC content (ALE-16).
 *
 * Three archetypes — a guard who blocks a door, a merchant whose dialogue is disposition-gated,
 * and a wounded scout with a quest hook — plus the gatehouse scene they stand in. Everything is
 * DATA: the authoring source is the JSON under `data/`, and this module only types it and
 * assembles it into a `Snapshot` the engine can drive.
 *
 * There is no behaviour here on purpose. Dialogue and combat are resolved by the GM through
 * engine tools (ALE-31/ALE-32); this package decides who exists, where they stand, what they are
 * made of, and what they want. `data/*.json` is the one copy both languages read: the Python GM
 * service (ALE-15) loads the same files for the memory block rather than getting a second copy.
 *
 * The component shapes come from `@deliberate/protocol` and are never redefined. `Disposition`
 * values are engine numbers in [-100, 100]; the prose in `dialogue[].text` is gated on those
 * numbers, not the other way round.
 */

import { parseMapRows } from '@deliberate/engine';
import {
  PROTOCOL_VERSION,
  type Brain,
  type Direction8,
  type Disposition,
  type Entity,
  type EntityId,
  type Faction,
  type FlagValue,
  type Health,
  type Inventory,
  type MapExit,
  type MapId,
  type MapRecord,
  type Portrait,
  type Quest,
  type QuestId,
  type Seed,
  type Snapshot,
  type Stats,
  type Tile,
} from '@deliberate/protocol';

import guardJson from '../data/guard.json' with { type: 'json' };
import merchantJson from '../data/merchant.json' with { type: 'json' };
import scoutJson from '../data/scout.json' with { type: 'json' };
import sceneJson from '../data/gatehouse.json' with { type: 'json' };
import laneJson from '../data/postern-lane.json' with { type: 'json' };

// ---------------------------------------------------------------------------------------------
// Disposition scale — the engine numbers every gate in this package is expressed in
// ---------------------------------------------------------------------------------------------

/** `Disposition.toward` is an engine number in this inclusive range. */
export const DISPOSITION_MIN = -100;
export const DISPOSITION_MAX = 100;

export function isDisposition(value: number): boolean {
  return Number.isInteger(value) && value >= DISPOSITION_MIN && value <= DISPOSITION_MAX;
}

/**
 * Named bands over the same scale, lowest bound first. The GM memory block and the dialogue
 * gates below share them so "hostile" means one thing across content and prompt.
 */
export const DISPOSITION_BANDS = [
  { band: 'hostile', min: -100 },
  { band: 'wary', min: -20 },
  { band: 'neutral', min: 0 },
  { band: 'friendly', min: 25 },
  { band: 'trusted', min: 60 },
] as const;

export type DispositionBand = (typeof DISPOSITION_BANDS)[number]['band'];

export function dispositionBand(value: number): DispositionBand {
  let out: DispositionBand = 'hostile';
  for (const b of DISPOSITION_BANDS) if (value >= b.min) out = b.band;
  return out;
}

/** What `npc` currently feels about `toward`; absent means never met, which reads as 0. */
export function dispositionToward(npc: Entity, toward: EntityId): number {
  return npc.components.disposition?.toward[toward] ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Content shapes
// ---------------------------------------------------------------------------------------------

/**
 * One line of the GM memory block. Short, and `refs`/`quest`/`flag` point at real ids so a goal
 * can be checked against the snapshot instead of only read.
 */
export interface NpcGoal {
  text: string;
  /** Entity ids the goal is about; every one must exist in the scene. */
  refs: EntityId[];
  /** Quest this goal advances, if any. */
  quest?: QuestId;
  /** World flag this goal is conditioned on, if any. */
  flag?: string;
}

/**
 * A seed line the GM may draw on, gated on the speaker's disposition toward `toward`. Bounds are
 * inclusive; omitting `maxDisposition` means "and above".
 */
export interface NpcDialogueSeed {
  text: string;
  toward: EntityId;
  minDisposition: number;
  maxDisposition?: number;
  tags: string[];
}

export type ArchetypeKind = 'guard' | 'merchant' | 'scout';

/** An authored NPC: protocol components plus the content-only goals and gated dialogue. */
export interface NpcArchetype {
  id: EntityId;
  archetype: ArchetypeKind;
  name: string;
  placement: Tile & { facing: Direction8 };
  stats: Stats;
  health: Health;
  inventory: Inventory;
  faction: Faction;
  disposition: Disposition;
  brain: Brain;
  portrait: Portrait;
  goals: NpcGoal[];
  dialogue: NpcDialogueSeed[];
}

/** The scene the three archetypes share. */
export interface SceneContent {
  mapId: MapId;
  seed: Seed;
  name: string;
  rows: string[];
  /** Ways off this map (ALE-43). Each one is matched by an entrance on the map it leads to. */
  exits: MapExit[];
  door: Tile;
  player: Tile & { facing: Direction8 };
  flags: Record<string, FlagValue>;
  quests: Record<QuestId, Quest>;
}

/**
 * A neighbouring location: terrain and the ways back, and nothing else (ALE-43).
 *
 * Nobody lives here and nothing happens here. It exists so the gatehouse has somewhere to be
 * next to — the thing `traverse` needs and the M1 scene never had — and so the client has a
 * second board to swap to. Populating it is `spawn`'s job and authoring one like it, without a
 * human writing the JSON, is the game master's (ALE-44).
 */
export interface NeighbourContent {
  mapId: MapId;
  name: string;
  rows: string[];
  exits: MapExit[];
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

/**
 * JSON imports widen to `string`/`number`, so the narrow protocol types (`Direction8`, the
 * archetype union) are asserted here and enforced by `npcs.test.ts`, which walks every field.
 */
function archetype(raw: unknown): NpcArchetype {
  return raw as NpcArchetype;
}

export const GUARD: NpcArchetype = archetype(guardJson);
export const MERCHANT: NpcArchetype = archetype(merchantJson);
export const SCOUT: NpcArchetype = archetype(scoutJson);

/** Authoring order, which is also the order they appear in the memory block. */
export const NPC_ARCHETYPES: readonly NpcArchetype[] = [GUARD, MERCHANT, SCOUT];

export const SCENE: SceneContent = sceneJson as SceneContent;

export const GATEHOUSE_MAP_ID: MapId = SCENE.mapId;
export const GATEHOUSE_SEED: Seed = SCENE.seed;
/** The tile the guard stands on. The only gap in the wall between the yard and the inner ward. */
export const GATEHOUSE_DOOR: Tile = { x: SCENE.door.x, y: SCENE.door.y };

export const GUARD_ID = GUARD.id;
export const MERCHANT_ID = MERCHANT.id;
export const SCOUT_ID = SCOUT.id;
/** Reuses the M0 fixture player id so server and client tests need no second player concept. */
export const GATEHOUSE_PLAYER_ID: EntityId = 'player';

export function byId(id: EntityId): NpcArchetype | undefined {
  return NPC_ARCHETYPES.find((n) => n.id === id);
}

export const POSTERN_LANE: NeighbourContent = laneJson as NeighbourContent;
export const POSTERN_LANE_MAP_ID: MapId = POSTERN_LANE.mapId;

/**
 * How much of the world to load around the gatehouse.
 *
 * `neighbours` exists for exactly one caller: the regression bank's generated sessions
 * (`packages/server/src/bank/generate.ts`) are recordings of the yard as M1 authored it, before
 * anywhere existed to walk to. A recording is evidence of a world that was, so the bank pins the
 * world it was recorded in rather than being rewritten every time the map grows. Everything else
 * — the server, the tests, the client — gets the whole neighbourhood.
 */
export interface GatehouseOptions {
  /** Load the lane beyond the postern and the exits between (ALE-43). Defaults to true. */
  neighbours?: boolean;
}

/** Fresh copy of the gatehouse map; the postern is an exit on it, not a hole in the wall. */
export function gatehouseMap(options: GatehouseOptions = {}): MapRecord {
  const map = parseMapRows(GATEHOUSE_MAP_ID, SCENE.rows);
  return options.neighbours === false ? map : { ...map, exits: structuredClone(SCENE.exits) };
}

/** Fresh copy of the lane outside the postern, with the way back in. */
export function posternLaneMap(): MapRecord {
  return {
    ...parseMapRows(POSTERN_LANE_MAP_ID, POSTERN_LANE.rows),
    exits: structuredClone(POSTERN_LANE.exits),
  };
}

/** Every map the gatehouse scene loads, in authoring order. */
export function gatehouseMaps(options: GatehouseOptions = {}): MapRecord[] {
  const maps = [gatehouseMap(options)];
  if (options.neighbours !== false) maps.push(posternLaneMap());
  return maps;
}

/** The protocol `Entity` for an archetype. Cosmetic `dialogue.seeds` is the gated lines, flattened. */
export function npcEntity(npc: NpcArchetype): Entity {
  return structuredClone({
    id: npc.id,
    name: npc.name,
    components: {
      position: {
        map: GATEHOUSE_MAP_ID,
        x: npc.placement.x,
        y: npc.placement.y,
        facing: npc.placement.facing,
      },
      stats: npc.stats,
      health: npc.health,
      inventory: npc.inventory,
      faction: npc.faction,
      disposition: npc.disposition,
      brain: npc.brain,
      dialogue: { seeds: npc.dialogue.map((d) => d.text) },
      portrait: npc.portrait,
    },
  });
}

/** The player who walks into the yard. Same stat line as the M0 fixture player. */
export function gatehousePlayer(): Entity {
  return {
    id: GATEHOUSE_PLAYER_ID,
    name: 'Player',
    components: {
      position: {
        map: GATEHOUSE_MAP_ID,
        x: SCENE.player.x,
        y: SCENE.player.y,
        facing: SCENE.player.facing,
      },
      stats: {
        str: 16,
        dex: 14,
        con: 14,
        int: 10,
        wis: 12,
        cha: 10,
        ac: 16,
        speed: 30,
        proficiency: 2,
      },
      health: { hp: 12, maxHp: 12, conditions: [] },
      inventory: {
        items: [
          { item: 'longsword', qty: 1 },
          { item: 'coin', qty: 25 },
        ],
      },
      faction: { id: 'party' },
      disposition: { toward: {} },
      brain: { policy: 'player' },
      dialogue: { seeds: [] },
      portrait: { asset: 'portraits/player.png' },
    },
  };
}

/**
 * The whole scene as a `Snapshot`: the player and all three archetypes in the yard, the lane
 * beyond the postern loaded and empty, no encounter running. Fresh objects on every call. Additive to the M0 fixtures, which stay as they are.
 */
export function gatehouseSnapshot(options: GatehouseOptions = {}): Snapshot {
  const entities: Record<EntityId, Entity> = {};
  for (const e of [gatehousePlayer(), ...NPC_ARCHETYPES.map(npcEntity)]) entities[e.id] = e;
  const maps: Record<MapId, MapRecord> = {};
  // Two maps since ALE-43: the yard everyone stands in, and the lane the postern lets out onto.
  // Nothing is on the lane — it is somewhere to walk to, which is what `traverse` needed.
  for (const map of gatehouseMaps(options)) maps[map.id] = map;
  return {
    schema: PROTOCOL_VERSION,
    entities,
    world: {
      flags: structuredClone(SCENE.flags),
      quests: structuredClone(SCENE.quests),
      clock: 0,
      maps,
    },
    initiative: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Accessors the GM side reads (goals for the memory block, dialogue gated on live dispositions)
// ---------------------------------------------------------------------------------------------

/** Seeds `npc` would offer at `disposition`, in authoring order. Inclusive bounds. */
export function dialogueSeedsFor(npc: NpcArchetype, disposition: number): NpcDialogueSeed[] {
  return npc.dialogue.filter(
    (d) => disposition >= d.minDisposition && (d.maxDisposition ?? DISPOSITION_MAX) >= disposition,
  );
}

/** The same, resolved against a live snapshot: reads the speaker's current disposition. */
export function dialogueSeedsInSnapshot(
  snapshot: Snapshot,
  npcId: EntityId,
  toward: EntityId = GATEHOUSE_PLAYER_ID,
): NpcDialogueSeed[] {
  const npc = byId(npcId);
  const entity = snapshot.entities[npcId];
  if (!npc || !entity) return [];
  return dialogueSeedsFor(npc, dispositionToward(entity, toward)).filter(
    (d) => d.toward === toward,
  );
}

/** Goal text per NPC, for the GM memory block. */
export function npcGoals(): Record<EntityId, string[]> {
  const out: Record<EntityId, string[]> = {};
  for (const npc of NPC_ARCHETYPES) out[npc.id] = npc.goals.map((g) => g.text);
  return out;
}
