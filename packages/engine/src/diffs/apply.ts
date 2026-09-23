import type { Diff, Entity, EntityId, Health, Position, Snapshot } from '@deliberate/protocol';

import { directionTo } from '../grid/index.js';

/**
 * `apply(snapshot, diffs)` — the one reduction from a snapshot plus a diff stream back to a
 * snapshot. The engine mutates its store directly; everyone else (the client's render copy, the
 * recorder's replay checks, tests) reconstructs state by folding the diffs the engine emitted
 * over the snapshot it emitted them from. Those two paths must agree, so this module mirrors the
 * rules layer exactly: it derives facing from the moved path the way `applyMove` does and drains
 * temporary hit points the way `applyDamage` does.
 *
 * Pure: the input snapshot is never touched; a deep copy is made once per call and returned.
 * Every diff is absolute rather than relative ("hp is now 4", not "lost 3"), so applying the same
 * sequence twice lands on the same state as applying it once.
 */

export class DiffError extends Error {
  override readonly name = 'DiffError';
}

/** Fold `diffs` over a copy of `snapshot`. Throws `DiffError` if a diff names something missing. */
export function apply(snapshot: Snapshot, diffs: readonly Diff[]): Snapshot {
  const next = structuredClone(snapshot);
  for (const diff of diffs) applyInto(next, diff);
  return next;
}

/** Convenience for a single diff; same contract as `apply`. */
export function applyDiff(snapshot: Snapshot, diff: Diff): Snapshot {
  return apply(snapshot, [diff]);
}

function mustEntity(state: Snapshot, id: EntityId): Entity {
  const entity = state.entities[id];
  if (!entity) throw new DiffError(`diff refers to unknown entity ${id}`);
  return entity;
}

function mustPosition(state: Snapshot, id: EntityId): Position {
  const position = mustEntity(state, id).components.position;
  if (!position) throw new DiffError(`entity ${id} has no position component`);
  return position;
}

function mustHealth(state: Snapshot, id: EntityId): Health {
  const health = mustEntity(state, id).components.health;
  if (!health) throw new DiffError(`entity ${id} has no health component`);
  return health;
}

/** Mutates `state` in place. Private: only `apply` calls it, and only on a copy it owns. */
function applyInto(state: Snapshot, diff: Diff): void {
  switch (diff.type) {
    case 'EntityMoved': {
      const position = mustPosition(state, diff.entity);
      const facing = directionTo(diff.path.at(-2) ?? diff.from, diff.to) ?? position.facing;
      position.x = diff.to.x;
      position.y = diff.to.y;
      if (facing) position.facing = facing;
      return;
    }
    case 'EntityTraversed': {
      // A crossing is a cut, not a walk: the map changes and the tile with it, and facing is
      // left where the last step put it. Absolute, so folding it twice lands where once did.
      const position = mustPosition(state, diff.entity);
      position.map = diff.toMap;
      position.x = diff.to.x;
      position.y = diff.to.y;
      return;
    }
    case 'DamageApplied': {
      const health = mustHealth(state, diff.target);
      if (health.tempHp !== undefined) {
        health.tempHp = Math.max(0, health.tempHp - Math.max(0, diff.amount));
      }
      health.hp = diff.hpAfter;
      return;
    }
    case 'ConditionSet': {
      const health = mustHealth(state, diff.entity);
      const present = health.conditions.includes(diff.condition);
      if (diff.active && !present) health.conditions = [...health.conditions, diff.condition];
      if (!diff.active && present) {
        health.conditions = health.conditions.filter((c) => c !== diff.condition);
      }
      return;
    }
    case 'DialogueLine':
      // Narration only: it changes what the player hears, never the world.
      return;
    case 'FlagSet':
      state.world.flags[diff.key] = diff.value;
      return;
    case 'EntitySpawned':
      state.entities[diff.entity.id] = structuredClone(diff.entity);
      return;
    case 'TurnAdvanced':
      state.initiative = diff.initiative === null ? null : structuredClone(diff.initiative);
      state.world.clock = diff.clock;
      return;
    case 'EconomySpent': {
      const init = state.initiative;
      if (!init) throw new DiffError(`${diff.entity} spent turn economy with no encounter running`);
      init.turn = { ...diff.turn };
      return;
    }
    case 'FacingChanged':
      mustPosition(state, diff.entity).facing = diff.facing;
      return;
    case 'DispositionChanged': {
      const disposition = mustEntity(state, diff.entity).components.disposition;
      if (!disposition) {
        throw new DiffError(`entity ${diff.entity} has no disposition component`);
      }
      disposition.toward[diff.toward] = diff.value;
      return;
    }
    case 'MapAuthored': {
      // The map's bytes travel in the diff, so folding a recording back rebuilds a location the
      // game master wrote without anything ever calling the model again (ALE-44).
      state.world.maps[diff.map.id] = structuredClone(diff.map);
      for (const link of diff.links) {
        const map = state.world.maps[link.map];
        if (!map) throw new DiffError(`diff links unknown map ${link.map}`);
        map.exits = structuredClone(link.exits);
        map.frontiers = structuredClone(link.frontiers);
      }
      return;
    }
    case 'QuestAdvanced': {
      const quest = state.world.quests[diff.quest];
      if (!quest) throw new DiffError(`diff refers to unknown quest ${diff.quest}`);
      quest.step = diff.step;
      return;
    }
    default:
      throw new DiffError(`unknown diff type ${String((diff as Diff).type)}`);
  }
}
