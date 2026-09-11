import type { Diff, Entity, EntityId, Health, Snapshot } from '@deliberate/protocol';

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

function mustHealth(state: Snapshot, id: EntityId): Health {
  const health = mustEntity(state, id).components.health;
  if (!health) throw new DiffError(`entity ${id} has no health component`);
  return health;
}

/** Mutates `state` in place. Private: only `apply` calls it, and only on a copy it owns. */
function applyInto(state: Snapshot, diff: Diff): void {
  switch (diff.type) {
    case 'EntityMoved': {
      const position = mustEntity(state, diff.entity).components.position;
      if (!position) throw new DiffError(`entity ${diff.entity} has no position component`);
      const facing = directionTo(diff.path.at(-2) ?? diff.from, diff.to) ?? position.facing;
      position.x = diff.to.x;
      position.y = diff.to.y;
      if (facing) position.facing = facing;
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
    default:
      throw new DiffError(`unknown diff type ${String((diff as Diff).type)}`);
  }
}
