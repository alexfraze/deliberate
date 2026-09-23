/**
 * The client's render-only copy of the world: snapshot in, diffs applied on top.
 *
 * This is NOT authoritative. The server owns state; this exists so the renderer knows where to
 * draw a capsule and what HP to show. It deliberately does not import `@deliberate/engine` and
 * keeps only what a frame needs. Pure data + pure functions, so it unit-tests under node.
 */
import type {
  Diff,
  EntityId,
  FactionId,
  InitiativeState,
  MapId,
  MapRecord,
  Snapshot,
  Tile,
} from '@deliberate/protocol';

export interface ViewEntity {
  id: EntityId;
  name: string;
  faction: FactionId;
  /** Which map they are standing on. Only those on `ViewState.mapId` are drawn (ALE-43). */
  map: MapId;
  tile: Tile;
  hp: number;
  maxHp: number;
  conditions: string[];
}

export interface ViewState {
  /** The map being rendered: wherever the player character is standing. */
  mapId: MapId | null;
  map: MapRecord | null;
  /**
   * Every loaded map, so a crossing is a swap of what is drawn rather than a round trip to the
   * server. The snapshot already carried them; nothing ever looked past the first one (ALE-43).
   */
  maps: Record<MapId, MapRecord>;
  /** The player character, whose map decides which board is on screen. Null before joining. */
  player: EntityId | null;
  /** Everyone, on every map. `entitiesHere` is what the renderer draws. */
  entities: Record<EntityId, ViewEntity>;
  /**
   * Turn order, or null out of combat. Kept up to date entirely from the diff stream
   * (`TurnAdvanced`, `EconomySpent`) — the client never asks the server whose turn it is.
   */
  initiative: InitiativeState | null;
}

export function isAlive(entity: ViewEntity): boolean {
  return entity.hp > 0;
}

function toViewEntity(
  id: EntityId,
  name: string,
  components: Snapshot['entities'][string]['components'],
): ViewEntity | null {
  const position = components.position;
  if (!position) return null;
  return {
    id,
    name,
    faction: components.faction?.id ?? 'neutral',
    map: position.map,
    tile: { x: position.x, y: position.y },
    hp: components.health?.hp ?? 1,
    maxHp: components.health?.maxHp ?? 1,
    conditions: [...(components.health?.conditions ?? [])],
  };
}

/** Builds the render model from a snapshot. The snapshot itself is never mutated or retained. */
export function viewFromSnapshot(snapshot: Snapshot): ViewState {
  const entities: Record<EntityId, ViewEntity> = {};
  let player: EntityId | null = null;
  let first: MapId | null = null;
  for (const [id, entity] of Object.entries(snapshot.entities)) {
    const view = toViewEntity(id, entity.name, entity.components);
    if (!view) continue;
    entities[id] = view;
    first ??= view.map;
    if (player === null && entity.components.brain?.policy === 'player') player = id;
  }
  // The rendered board is wherever the player is standing. With one map loaded that is the map,
  // which is what it has always been; with several it is the only answer that is not a guess.
  const mapId =
    (player === null ? null : (entities[player]?.map ?? null)) ??
    first ??
    Object.keys(snapshot.world.maps)[0] ??
    null;
  const maps = structuredClone(snapshot.world.maps);
  return {
    mapId,
    map: mapId === null ? null : (maps[mapId] ?? null),
    maps,
    player,
    entities,
    initiative: structuredClone(snapshot.initiative),
  };
}

export function emptyView(): ViewState {
  return { mapId: null, map: null, maps: {}, player: null, entities: {}, initiative: null };
}

/** The entities on the map being rendered. Everyone else is somewhere the camera is not. */
export function entitiesHere(view: ViewState): ViewEntity[] {
  return Object.values(view.entities).filter((entity) => entity.map === view.mapId);
}

/**
 * Folds one diff into the render model. `EntityMoved` jumps straight to `to`: the smooth tween is
 * the animation queue's job, and it reads the diff's `path` itself.
 */
export function applyDiffToView(view: ViewState, diff: Diff): void {
  switch (diff.type) {
    case 'EntityMoved': {
      const entity = view.entities[diff.entity];
      if (entity) entity.tile = { x: diff.to.x, y: diff.to.y };
      return;
    }
    case 'EntityTraversed': {
      const entity = view.entities[diff.entity];
      if (!entity) return;
      entity.map = diff.toMap;
      entity.tile = { x: diff.to.x, y: diff.to.y };
      // When the player walks through, the board swaps: a different map, and with it a different
      // cast. Everyone left behind is still in `entities` and simply stops being drawn.
      if (diff.entity === view.player) {
        view.mapId = diff.toMap;
        view.map = view.maps[diff.toMap] ?? null;
      }
      return;
    }
    case 'DamageApplied': {
      const entity = view.entities[diff.target];
      if (entity) entity.hp = diff.hpAfter;
      return;
    }
    case 'ConditionSet': {
      const entity = view.entities[diff.entity];
      if (!entity) return;
      const has = entity.conditions.includes(diff.condition);
      if (diff.active && !has) entity.conditions.push(diff.condition);
      if (!diff.active && has) {
        entity.conditions = entity.conditions.filter((c) => c !== diff.condition);
      }
      return;
    }
    case 'EntitySpawned': {
      const spawned = toViewEntity(diff.entity.id, diff.entity.name, diff.entity.components);
      if (spawned) view.entities[spawned.id] = spawned;
      return;
    }
    case 'TurnAdvanced': {
      view.initiative = structuredClone(diff.initiative);
      return;
    }
    case 'EconomySpent': {
      if (view.initiative) view.initiative.turn = { ...diff.turn };
      return;
    }
    case 'DialogueLine':
    case 'FlagSet':
    case 'FacingChanged':
      // Nothing on screen depends on these yet: narration lands in M1, and the capsules the
      // renderer draws have no front.
      return;
  }
}

export function applyDiffsToView(view: ViewState, diffs: readonly Diff[]): void {
  for (const diff of diffs) applyDiffToView(view, diff);
}
