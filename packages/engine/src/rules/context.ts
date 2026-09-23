import type {
  Diff,
  Entity,
  EntityId,
  InitiativeState,
  MapRecord,
  Tile,
  Verdict,
} from '@deliberate/protocol';

import { tileKey } from '../grid/index.js';
import type { Store } from '../store/index.js';
import { isAlive, isIncapacitated } from './conditions.js';
import type { Rng } from './rng.js';

/**
 * The pieces every intent handler shares: what the engine is holding (`EngineContext`), how a
 * verdict is built, and the checks that must pass before anything is allowed to act.
 *
 * Split out of create-engine.ts in ALE-31 so the M1 intent handlers in `src/gm/` can reuse them
 * without an import cycle. Pure reads: nothing in this file mutates the store.
 */

export interface EngineContext {
  store: Store;
  rng: Rng;
  /**
   * Entity templates `spawn` may instantiate, keyed by template id. The engine is I/O free, so
   * whoever builds it (the server, from `content/npcs/`) hands the templates in. Empty by
   * default, which makes every `spawn` reject with the list of known templates.
   */
  templates: Readonly<Record<string, Entity>>;
}

export function reject(reason: string): Verdict {
  return { ok: false, reason, diff: [] };
}

export function accept(diff: Diff[]): Verdict {
  return { ok: true, diff };
}

export function isVerdict(v: unknown): v is Verdict {
  return typeof v === 'object' && v !== null && 'ok' in v;
}

export function describeTile(t: Tile): string {
  return `(${t.x}, ${t.y})`;
}

/** Tiles occupied by entities on `map` (dead ones included; a body still fills a square). */
export function occupiedTiles(store: Store, map: string, except?: EntityId): Set<string> {
  const out = new Set<string>();
  for (const id of store.entityIds()) {
    if (id === except) continue;
    const pos = store.getComponent(id, 'position');
    if (pos && pos.map === map) out.add(tileKey(pos));
  }
  return out;
}

/** An entity resolved far enough to act on: on a known map, with stats and hit points. */
export interface Actor {
  entity: Entity;
  position: NonNullable<Entity['components']['position']>;
  stats: NonNullable<Entity['components']['stats']>;
  health: NonNullable<Entity['components']['health']>;
  map: MapRecord;
}

/** An entity that can act: exists, is on a known map, has stats and hit points, is not down. */
export function checkActor(store: Store, id: EntityId, verb: string): Actor | Verdict {
  const entity = store.getEntity(id);
  if (!entity) return reject(`There is no one called ${id} here.`);
  const { position, health, stats } = entity.components;
  if (!position) return reject(`${entity.name} is not on the map.`);
  if (!health) return reject(`${entity.name} has no hit points and cannot act.`);
  if (!isAlive(health)) return reject(`${entity.name} is dead and cannot ${verb}.`);
  if (isIncapacitated(health)) return reject(`${entity.name} is unconscious and cannot ${verb}.`);
  if (!stats) return reject(`${entity.name} has no stats and cannot ${verb}.`);
  const map = store.getMap(position.map);
  if (!map) return reject(`${entity.name} is on an unknown map.`);
  return { entity, position, stats, health, map };
}

/** In an encounter, only the current entity acts. Outside one, `null`. */
export function checkTurn(store: Store, actor: Actor): InitiativeState | null | Verdict {
  const init = store.initiative();
  if (!init) return null;
  const current = init.order[init.current];
  if (current !== actor.entity.id) {
    const name = current ? (store.getEntity(current)?.name ?? current) : 'nobody';
    return reject(`It is ${name}'s turn, not ${actor.entity.name}'s.`);
  }
  return init;
}

/**
 * What a `null` map argument means now that a world can hold more than one map (ALE-43).
 *
 * With one map loaded it is that map, exactly as `soleMap` has always said. With several, it is
 * the map the player character is standing on — "here", which is what an unqualified tile in a
 * tool call has always meant and, until a second map existed, could only have meant. Guessing
 * between two maps with nobody to anchor it would be a silent wrong answer, so that still fails.
 */
export function defaultMap(store: Store): MapRecord | Verdict {
  const ids = Object.keys(store.world().maps).sort();
  if (ids.length <= 1) return soleMap(store);
  for (const id of store.entityIds()) {
    const entity = store.getEntity(id)!;
    if (entity.components.brain?.policy !== 'player') continue;
    const map = entity.components.position?.map;
    const record = map === undefined ? undefined : store.getMap(map);
    if (record) return record;
  }
  return reject(`Several maps are loaded: ${ids.join(', ')}.`);
}

/**
 * The only loaded map when there is exactly one, which is what a `null` map argument means. With
 * several loaded the caller has to say which, because guessing would be a silent wrong answer.
 */
export function soleMap(store: Store): MapRecord | Verdict {
  const ids = Object.keys(store.world().maps).sort();
  const only = ids.length === 1 ? ids[0] : undefined;
  if (only === undefined) {
    return reject(
      ids.length === 0 ? 'No map is loaded.' : `Several maps are loaded: ${ids.join(', ')}.`,
    );
  }
  return store.getMap(only)!;
}
