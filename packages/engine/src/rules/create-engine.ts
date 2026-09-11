import {
  type Diff,
  type EntityId,
  type Intent,
  type MapRecord,
  type MoveIntent,
  type Snapshot,
  type Tile,
  type Verdict,
} from '@deliberate/protocol';

import type { Engine, EngineOptions } from '../engine.js';
import { feetToTiles, inBounds, isWalkable, path, tileKey } from '../grid/index.js';
import { hashSnapshot } from '../hash/index.js';
import { createStore, type Store } from '../store/index.js';
import { createRng, type Rng } from './rng.js';

/**
 * The engine: a store, a seeded RNG, and `apply`, which validates an intent completely before
 * touching the store and emits one diff per mutation.
 *
 * ALE-8 ships `move` with basic legality (entity exists and is alive, destination walkable and
 * free, a path exists within `Stats.speed`). ALE-9 replaces the validation with the full action
 * economy, initiative, and attacks; the shape of this function does not change.
 */
export function createEngine(initial: Snapshot, options: EngineOptions): Engine {
  const store = createStore(initial);
  const rng = createRng(options.seed);
  const ctx: EngineContext = { store, rng };

  return {
    snapshot: () => store.snapshot(),
    hash: () => hashSnapshot(store.snapshot()),
    apply(intent) {
      switch (intent.kind) {
        case 'move':
          return applyMove(ctx, intent);
        case 'attack':
          return reject('Attacking is not available yet.');
        case 'end_turn':
          return reject('Ending your turn is not available yet.');
        default:
          return reject(`Unknown intent ${String((intent as Intent).kind)}.`);
      }
    },
  };
}

export interface EngineContext {
  store: Store;
  rng: Rng;
}

export function reject(reason: string): Verdict {
  return { ok: false, reason, diff: [] };
}

export function accept(diff: Diff[]): Verdict {
  return { ok: true, diff };
}

/** Tiles occupied by living or dead entities on `map`, except `except`. */
export function occupiedTiles(store: Store, map: string, except?: EntityId): Set<string> {
  const out = new Set<string>();
  for (const id of store.entityIds()) {
    if (id === except) continue;
    const pos = store.getComponent(id, 'position');
    if (pos && pos.map === map) out.add(tileKey(pos));
  }
  return out;
}

export function describeTile(t: Tile): string {
  return `(${t.x}, ${t.y})`;
}

interface MoveCheck {
  map: MapRecord;
  from: Tile;
  steps: Tile[];
}

/** Validate a move; returns the resolved path or a rejection. Reads only; never mutates. */
export function checkMove(store: Store, intent: MoveIntent): MoveCheck | Verdict {
  const entity = store.getEntity(intent.entity);
  if (!entity) return reject(`There is no one called ${intent.entity} here.`);
  const { position, health, stats } = entity.components;
  if (!position) return reject(`${entity.name} is not on the map.`);
  if (!health) return reject(`${entity.name} has no hit points and cannot act.`);
  if (health.hp <= 0) return reject(`${entity.name} is down and cannot move.`);
  if (!stats) return reject(`${entity.name} has no speed and cannot move.`);
  const map = store.getMap(position.map);
  if (!map) return reject(`${entity.name} is on an unknown map.`);
  const to = intent.to;
  if (!inBounds(map, to)) return reject(`${describeTile(to)} is off the map.`);
  if (!isWalkable(map, to)) return reject(`${describeTile(to)} cannot be walked on.`);
  const from = { x: position.x, y: position.y };
  if (from.x === to.x && from.y === to.y) return reject(`${entity.name} is already there.`);
  const blocked = occupiedTiles(store, position.map, entity.id);
  if (blocked.has(tileKey(to))) return reject(`${describeTile(to)} is occupied.`);
  const budget = feetToTiles(stats.speed);
  const steps = path(map, from, to, budget, { blocked });
  if (!steps) {
    const unbounded = path(map, from, to, map.width * map.height, { blocked });
    if (!unbounded) return reject(`No path to ${describeTile(to)}.`);
    return reject(
      `${describeTile(to)} is ${unbounded.length * 5} ft away; ${entity.name} can move ${stats.speed} ft.`,
    );
  }
  return { map, from, steps };
}

function applyMove(ctx: EngineContext, intent: MoveIntent): Verdict {
  const check = checkMove(ctx.store, intent);
  if ('ok' in check) return check;
  const position = ctx.store.getComponent(intent.entity, 'position')!;
  const to = check.steps.at(-1)!;
  const prev = check.steps.at(-2) ?? check.from;
  const facing = directionOf(prev, to) ?? position.facing;
  ctx.store.setComponent(intent.entity, 'position', {
    ...position,
    x: to.x,
    y: to.y,
    ...(facing ? { facing } : {}),
  });
  return accept([
    { type: 'EntityMoved', entity: intent.entity, from: check.from, to, path: check.steps },
  ]);
}

function directionOf(from: Tile, to: Tile) {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  const table: Record<
    string,
    NonNullable<Snapshot['entities'][string]['components']['position']>['facing']
  > = {
    '0,-1': 'N',
    '1,-1': 'NE',
    '1,0': 'E',
    '1,1': 'SE',
    '0,1': 'S',
    '-1,1': 'SW',
    '-1,0': 'W',
    '-1,-1': 'NW',
  };
  return table[`${dx},${dy}`];
}
