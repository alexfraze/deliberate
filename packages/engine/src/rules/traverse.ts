import {
  TILE_FEET,
  type Diff,
  type InitiativeState,
  type MapExit,
  type MapRecord,
  type Tile,
  type TraverseIntent,
  type Verdict,
} from '@deliberate/protocol';

import { inBounds, isWalkable, tileEquals, tileKey } from '../grid/index.js';
import type { Store } from '../store/index.js';
import {
  accept,
  checkActor,
  checkTurn,
  describeTile,
  isVerdict,
  occupiedTiles,
  reject,
  type Actor,
  type EngineContext,
} from './context.js';
import { economyOf } from './initiative.js';

/**
 * `traverse` — walking off one map and onto another (ALE-43).
 *
 * `World.maps` has been a registry since ALE-8 and `Position.map` has been on every entity for
 * just as long, but nothing ever crossed between two of them: `move` validates a path across one
 * grid and there is no path between two grids. This is the missing verb, and it is pure engine —
 * both maps already exist, so no model is involved and a crossing replays like any other intent.
 *
 * It is validated the way everything else is, and the checks are exactly the ones a door has:
 *
 * - the exit is **under your feet** — not merely on the map, not adjacent;
 * - the far side is **loaded** — an exit to a map that has not been authored yet is refused, not
 *   invented (authoring it is ALE-44's job, and a separate verb);
 * - the entrance is **real terrain** — on the destination map, walkable, and not already occupied,
 *   because arriving inside a wall or inside somebody else is not a legal position to be in;
 * - you are **allowed to leave** — alive and, inside an encounter, on your own turn, with a step's
 *   worth of movement still to spend.
 *
 * A crossing costs one tile of movement, the same as stepping through the doorway would have. It
 * is not free and it is not the whole turn: it is a step, and the economy says so.
 */

/** A crossing costs the same as the step through the doorway it stands in for. */
export const TRAVERSE_COST_FT = TILE_FEET;

/** Exits on `map` whose `at` tile is `tile`. Authoring order; the engine never reorders content. */
export function exitsAt(map: MapRecord, tile: Tile): MapExit[] {
  return (map.exits ?? []).filter((exit) => tileEquals(exit.at, tile));
}

/** How a verdict names an exit: its label when it has one, otherwise the map it leads to. */
function nameOf(exit: MapExit): string {
  return exit.label ?? exit.to;
}

export interface TraverseCheck {
  actor: Actor;
  init: InitiativeState | null;
  exit: MapExit;
  destination: MapRecord;
  from: Tile;
}

/** Validate a crossing; returns the exit it would take or a rejection. Reads only; never mutates. */
export function checkTraverse(store: Store, intent: TraverseIntent): TraverseCheck | Verdict {
  const actor = checkActor(store, intent.entity, 'travel');
  if (isVerdict(actor)) return actor;
  const init = checkTurn(store, actor);
  if (isVerdict(init)) return init;
  const { entity, position, stats, map } = actor;
  const from: Tile = { x: position.x, y: position.y };

  const here = exitsAt(map, from);
  if (here.length === 0) {
    return reject(`There is no way out of ${map.id} from ${describeTile(from)}.`);
  }
  const exit =
    intent.to === null
      ? here.length === 1
        ? here[0]
        : undefined
      : here.find((e) => e.to === intent.to);
  if (!exit) {
    if (intent.to === null) {
      return reject(
        `${describeTile(from)} leads several ways: ${here.map(nameOf).join(', ')}. Say which.`,
      );
    }
    return reject(`${describeTile(from)} does not lead to ${intent.to}.`);
  }

  const destination = store.getMap(exit.to);
  if (!destination) return reject(`${nameOf(exit)} has not been mapped yet.`);
  if (!inBounds(destination, exit.entrance)) {
    return reject(
      `${nameOf(exit)} comes out at ${describeTile(exit.entrance)}, which is off the map.`,
    );
  }
  if (!isWalkable(destination, exit.entrance)) {
    return reject(
      `${nameOf(exit)} comes out at ${describeTile(exit.entrance)}, which cannot be stood on.`,
    );
  }
  if (occupiedTiles(store, exit.to, entity.id).has(tileKey(exit.entrance))) {
    return reject(`Someone is standing where ${nameOf(exit)} comes out.`);
  }

  if (init) {
    const remainingFt = stats.speed - economyOf(init).movedFt;
    if (remainingFt < TRAVERSE_COST_FT) {
      return reject(`${entity.name} has no movement left this turn.`);
    }
  }
  return { actor, init, exit, destination, from };
}

/**
 * Cross. The entity's `Position.map` changes, which is inside the state hash — an entity on
 * another map is a different world, so a crossing is visible to replay the way every other
 * mutation is. Facing is left alone: you go through a door looking the way you were walking.
 */
export function applyTraverse(ctx: EngineContext, intent: TraverseIntent): Verdict {
  const check = checkTraverse(ctx.store, intent);
  if (isVerdict(check)) return check;
  const { actor, init, exit, from } = check;
  ctx.store.setComponent(intent.entity, 'position', {
    ...actor.position,
    map: exit.to,
    x: exit.entrance.x,
    y: exit.entrance.y,
  });
  const diffs: Diff[] = [
    {
      type: 'EntityTraversed',
      entity: intent.entity,
      fromMap: actor.position.map,
      from,
      toMap: exit.to,
      to: { x: exit.entrance.x, y: exit.entrance.y },
    },
  ];
  if (init) {
    const turn = economyOf(init);
    const spent = { ...turn, movedFt: turn.movedFt + TRAVERSE_COST_FT };
    ctx.store.setInitiative({ ...init, turn: spent });
    diffs.push({ type: 'EconomySpent', entity: intent.entity, turn: spent });
  }
  return accept(diffs);
}
