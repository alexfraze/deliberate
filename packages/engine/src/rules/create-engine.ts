import {
  TILE_FEET,
  type AttackIntent,
  type Diff,
  type EndTurnIntent,
  type Entity,
  type EntityId,
  type InitiativeState,
  type Intent,
  type MapRecord,
  type MoveIntent,
  type Snapshot,
  type Tile,
  type Verdict,
} from '@deliberate/protocol';

import type { Engine, EngineOptions } from '../engine.js';
import {
  directionTo,
  distanceFeet,
  feetToTiles,
  inBounds,
  isWalkable,
  lineOfSight,
  path,
  tileKey,
} from '../grid/index.js';
import { hashSnapshot } from '../hash/index.js';
import { createStore, type Store } from '../store/index.js';
import { applyDamage, resolveAttack, type AttackResult } from './attack.js';
import { hasCondition, isAlive, isIncapacitated } from './conditions.js';
import { advanceTurn, economyOf, freshEconomy, rollInitiative } from './initiative.js';
import { createRng, type Rng } from './rng.js';
import { getWeapon, inRange, type Weapon } from './weapons.js';

/**
 * The engine: a store, a seeded RNG, and `apply`, which validates an intent completely before
 * touching the store and emits one diff per mutation.
 *
 * Rules (SRD 5.1 trimmed, see the rules/ modules):
 * - Exploration until the first attack: anyone alive may move up to their speed per intent.
 * - An attack starts an encounter: initiative is rolled for every combatant and the attacker acts
 *   first in round 1 (the ambush). From then on only the entity at `initiative.current` may act,
 *   with one move (speed in feet, spendable in pieces), one action, and one bonus action per
 *   turn; `end_turn` advances, skipping the dead and (in M0) anyone without a `player` brain.
 * - Rejections never mutate and carry a reason a player can read.
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
          return applyAttack(ctx, intent);
        case 'end_turn':
          return applyEndTurn(ctx, intent);
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

export function describeTile(t: Tile): string {
  return `(${t.x}, ${t.y})`;
}

function isVerdict(v: unknown): v is Verdict {
  return typeof v === 'object' && v !== null && 'ok' in v;
}

// ---------------------------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------------------------

interface Actor {
  entity: Entity;
  position: NonNullable<Entity['components']['position']>;
  stats: NonNullable<Entity['components']['stats']>;
  health: NonNullable<Entity['components']['health']>;
  map: MapRecord;
}

/** An entity that can act: exists, is on a known map, has stats and hit points, is not down. */
function checkActor(store: Store, id: EntityId, verb: string): Actor | Verdict {
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
function checkTurn(store: Store, actor: Actor): InitiativeState | null | Verdict {
  const init = store.initiative();
  if (!init) return null;
  const current = init.order[init.current];
  if (current !== actor.entity.id) {
    const name = current ? (store.getEntity(current)?.name ?? current) : 'nobody';
    return reject(`It is ${name}'s turn, not ${actor.entity.name}'s.`);
  }
  return init;
}

// ---------------------------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------------------------

interface MoveCheck {
  actor: Actor;
  init: InitiativeState | null;
  from: Tile;
  steps: Tile[];
}

/** Validate a move; returns the resolved path or a rejection. Reads only; never mutates. */
export function checkMove(store: Store, intent: MoveIntent): MoveCheck | Verdict {
  const actor = checkActor(store, intent.entity, 'move');
  if (isVerdict(actor)) return actor;
  const init = checkTurn(store, actor);
  if (isVerdict(init)) return init;
  const { entity, position, stats, map } = actor;
  const to = intent.to;
  if (!inBounds(map, to)) return reject(`${describeTile(to)} is off the map.`);
  if (!isWalkable(map, to)) return reject(`${describeTile(to)} cannot be walked on.`);
  const from = { x: position.x, y: position.y };
  if (from.x === to.x && from.y === to.y) return reject(`${entity.name} is already there.`);
  const blocked = occupiedTiles(store, position.map, entity.id);
  if (blocked.has(tileKey(to))) return reject(`${describeTile(to)} is occupied.`);
  const remainingFt = init ? stats.speed - economyOf(init).movedFt : stats.speed;
  const budget = feetToTiles(remainingFt);
  if (budget <= 0) return reject(`${entity.name} has no movement left this turn.`);
  const steps = path(map, from, to, budget, { blocked });
  if (!steps) {
    const unbounded = path(map, from, to, map.width * map.height, { blocked });
    if (!unbounded) return reject(`No path to ${describeTile(to)}.`);
    const need = unbounded.length * TILE_FEET;
    return reject(
      init
        ? `${describeTile(to)} is ${need} ft away; ${entity.name} has ${remainingFt} ft of movement left.`
        : `${describeTile(to)} is ${need} ft away; ${entity.name} can move ${stats.speed} ft.`,
    );
  }
  return { actor, init, from, steps };
}

function applyMove(ctx: EngineContext, intent: MoveIntent): Verdict {
  const check = checkMove(ctx.store, intent);
  if (isVerdict(check)) return check;
  const { actor, init, from, steps } = check;
  const to = steps.at(-1)!;
  const prev = steps.at(-2) ?? from;
  const facing = directionTo(prev, to) ?? actor.position.facing;
  ctx.store.setComponent(intent.entity, 'position', {
    ...actor.position,
    x: to.x,
    y: to.y,
    ...(facing ? { facing } : {}),
  });
  if (init) {
    const turn = economyOf(init);
    ctx.store.setInitiative({
      ...init,
      turn: { ...turn, movedFt: turn.movedFt + steps.length * TILE_FEET },
    });
  }
  return accept([{ type: 'EntityMoved', entity: intent.entity, from, to, path: steps }]);
}

// ---------------------------------------------------------------------------------------------
// attack
// ---------------------------------------------------------------------------------------------

interface AttackCheck {
  actor: Actor;
  target: Actor;
  init: InitiativeState | null;
  weapon: Weapon;
  distanceFt: number;
  /** Spends the bonus action (off-hand attack) instead of the action. */
  offhand: boolean;
}

/** Validate an attack completely. Reads only; never mutates and never rolls. */
export function checkAttack(store: Store, intent: AttackIntent): AttackCheck | Verdict {
  const actor = checkActor(store, intent.attacker, 'attack');
  if (isVerdict(actor)) return actor;
  const init = checkTurn(store, actor);
  if (isVerdict(init)) return init;
  const { entity, position, map } = actor;

  const weapon = getWeapon(intent.ability);
  if (!weapon) return reject(`${entity.name} does not know how to attack with ${intent.ability}.`);
  if (!weapon.natural) {
    const held = entity.components.inventory?.items.some((i) => i.item === weapon.key && i.qty > 0);
    if (!held) return reject(`${entity.name} does not have a ${weapon.name}.`);
  }

  if (intent.target === entity.id) return reject(`${entity.name} cannot attack themself.`);
  const target = store.getEntity(intent.target);
  if (!target) return reject(`There is no one called ${intent.target} here.`);
  const tPos = target.components.position;
  const tHealth = target.components.health;
  const tStats = target.components.stats;
  if (!tPos || tPos.map !== position.map) return reject(`${target.name} is not here.`);
  if (!tHealth || !tStats) return reject(`${target.name} cannot be attacked.`);
  if (!isAlive(tHealth)) return reject(`${target.name} is already dead.`);

  let offhand = false;
  if (init) {
    const turn = economyOf(init);
    if (turn.actionUsed) {
      if (turn.bonusActionUsed) {
        return reject(`${entity.name} has already used their action and bonus action this turn.`);
      }
      if (!weapon.light) {
        return reject(
          `${entity.name} has already used their action this turn; only a light weapon can be used as a bonus action.`,
        );
      }
      offhand = true;
    }
  }

  const distanceFt = distanceFeet(position, tPos);
  if (!inRange(weapon, distanceFt)) {
    const reach = Math.max(weapon.reachFt ?? 0, weapon.rangeFt?.long ?? 0);
    return reject(`${target.name} is ${distanceFt} ft away; a ${weapon.name} reaches ${reach} ft.`);
  }
  if (!lineOfSight(map, position, tPos)) {
    return reject(`${entity.name} cannot see ${target.name} from here.`);
  }

  return {
    actor,
    target: { entity: target, position: tPos, stats: tStats, health: tHealth, map },
    init,
    weapon,
    distanceFt,
    offhand,
  };
}

/** A living, non-incapacitated entity of another faction within 5 ft of `actor`, target included. */
function hostileAdjacent(store: Store, actor: Actor): boolean {
  const faction = actor.entity.components.faction?.id;
  for (const id of store.entityIds()) {
    if (id === actor.entity.id) continue;
    const other = store.getEntity(id)!;
    const pos = other.components.position;
    if (!pos || pos.map !== actor.position.map) continue;
    if (distanceFeet(pos, actor.position) > TILE_FEET) continue;
    if (isIncapacitated(other.components.health)) continue;
    if (other.components.faction?.id === faction) continue;
    return true;
  }
  return false;
}

/** Roll initiative for everyone and let `first` act now: the attacker who opened the encounter. */
function startEncounter(ctx: EngineContext, first: EntityId): InitiativeState {
  const order = rollInitiative(ctx.store, ctx.rng).map((r) => r.entity);
  const current = Math.max(0, order.indexOf(first));
  const init: InitiativeState = { order, current, round: 1, turn: freshEconomy() };
  ctx.store.setInitiative(init);
  return init;
}

function applyAttack(ctx: EngineContext, intent: AttackIntent): Verdict {
  const check = checkAttack(ctx.store, intent);
  if (isVerdict(check)) return check;
  const { actor, target, weapon, distanceFt, offhand } = check;
  const init = check.init ?? startEncounter(ctx, actor.entity.id);

  const result: AttackResult = resolveAttack(ctx.rng, {
    attacker: { stats: actor.stats, health: actor.health },
    target: { stats: target.stats, health: target.health },
    weapon,
    distanceFt,
    hostileAdjacent: hostileAdjacent(ctx.store, actor),
    offhand,
  });

  const diffs: Diff[] = [];
  if (result.hit) {
    const after = applyDamage(target.health, result.damage);
    const died = after.hp <= 0 && !hasCondition(after, 'dead');
    if (died) after.conditions = [...after.conditions, 'dead'];
    ctx.store.setComponent(target.entity.id, 'health', after);
    diffs.push({
      type: 'DamageApplied',
      target: target.entity.id,
      amount: result.damage,
      source: actor.entity.id,
      hpAfter: after.hp,
    });
    if (died) {
      diffs.push({
        type: 'ConditionSet',
        entity: target.entity.id,
        condition: 'dead',
        active: true,
      });
    }
  }

  const turn = economyOf(init);
  ctx.store.setInitiative({
    ...init,
    turn: offhand ? { ...turn, bonusActionUsed: true } : { ...turn, actionUsed: true },
  });
  const facing = directionTo(actor.position, target.position);
  if (facing && facing !== actor.position.facing) {
    ctx.store.setComponent(actor.entity.id, 'position', { ...actor.position, facing });
  }
  return accept(diffs);
}

// ---------------------------------------------------------------------------------------------
// end_turn
// ---------------------------------------------------------------------------------------------

export function checkEndTurn(store: Store, intent: EndTurnIntent): InitiativeState | Verdict {
  const actor = checkActor(store, intent.entity, 'end their turn');
  if (isVerdict(actor)) return actor;
  const init = checkTurn(store, actor);
  if (isVerdict(init)) return init;
  if (!init) return reject('No encounter is running; there is no turn to end.');
  return init;
}

function applyEndTurn(ctx: EngineContext, intent: EndTurnIntent): Verdict {
  const init = checkEndTurn(ctx.store, intent);
  if (isVerdict(init)) return init;
  const next = advanceTurn(ctx.store, init);
  ctx.store.setInitiative(next.state);
  if (next.roundsPassed > 0) ctx.store.setClock(ctx.store.clock() + next.roundsPassed);
  return accept([]);
}
