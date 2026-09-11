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
  MapId,
  MapRecord,
  Snapshot,
  Tile,
} from '@deliberate/protocol';

export interface ViewEntity {
  id: EntityId;
  name: string;
  faction: FactionId;
  tile: Tile;
  hp: number;
  maxHp: number;
  conditions: string[];
}

export interface ViewState {
  mapId: MapId | null;
  map: MapRecord | null;
  entities: Record<EntityId, ViewEntity>;
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
    tile: { x: position.x, y: position.y },
    hp: components.health?.hp ?? 1,
    maxHp: components.health?.maxHp ?? 1,
    conditions: [...(components.health?.conditions ?? [])],
  };
}

/** Builds the render model from a snapshot. The snapshot itself is never mutated or retained. */
export function viewFromSnapshot(snapshot: Snapshot): ViewState {
  const entities: Record<EntityId, ViewEntity> = {};
  let mapId: MapId | null = null;
  for (const [id, entity] of Object.entries(snapshot.entities)) {
    const view = toViewEntity(id, entity.name, entity.components);
    if (!view) continue;
    entities[id] = view;
    mapId ??= entity.components.position?.map ?? null;
  }
  mapId ??= Object.keys(snapshot.world.maps)[0] ?? null;
  const map = mapId === null ? null : (snapshot.world.maps[mapId] ?? null);
  return { mapId, map, entities };
}

export function emptyView(): ViewState {
  return { mapId: null, map: null, entities: {} };
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
    case 'DialogueLine':
    case 'FlagSet':
      // Nothing on screen depends on these yet (narration lands in M1).
      return;
  }
}

export function applyDiffsToView(view: ViewState, diffs: readonly Diff[]): void {
  for (const diff of diffs) applyDiffToView(view, diff);
}
