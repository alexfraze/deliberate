import {
  TILE_FEET,
  type AttackIntent,
  type CastIntent,
  type Diff,
  type EndTurnIntent,
  type EntityId,
  type InitiativeState,
  type Intent,
  type MoveIntent,
  type PassTimeIntent,
  type Snapshot,
  type Tile,
  type Verdict,
} from '@deliberate/protocol';

import type { Engine, EngineOptions } from '../engine.js';
import { applyWorldIntent } from '../gm/intents.js';
import { SPELL_ACTION } from '../gm/spells.js';
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
import { advanceTurn, economyOf, freshEconomy, rollInitiative } from './initiative.js';
import { createRng } from './rng.js';
import { applyTraverse } from './traverse.js';
import { inRange, WEAPON_ACTION, type AttackAction, type Weapon } from './weapons.js';

/**
 * The engine: a store, a seeded RNG, and `apply`, which validates an intent completely before
 * touching the store and emits one diff per mutation.
 *
 * Rules (SRD 5.1 trimmed, see the rules/ modules):
 * - Exploration until the first attack: anyone alive may move up to their speed per intent.
 * - A `traverse` walks through an exit onto another loaded map, for one tile's worth of movement.
 *   Walking between maps is the one movement a path cannot express; see rules/traverse.ts.
 * - An attack starts an encounter: initiative is rolled for every combatant and the attacker acts
 *   first in round 1 (the ambush). From then on only the entity at `initiative.current` may act,
 *   with one move (speed in feet, spendable in pieces), one action, and one bonus action per
 *   turn; `end_turn` advances, skipping the dead and (in M0) anyone without a `player` brain.
 * - Outside an encounter the player may instead `pass_time`: the world clock moves on by a round
 *   and nothing else in the store changes. It is the hook the server hangs the ambient world turn
 *   on (ALE-41), and the engine deliberately knows nothing about that — here it is just a clock.
 * - Rejections never mutate and carry a reason a player can read.
 */
export function createEngine(initial: Snapshot, options: EngineOptions): Engine {
  const store = createStore(initial);
  const rng = createRng(options.seed, options.rngCalls ?? 0);
  const ctx: EngineContext = { store, rng, templates: options.templates ?? {} };

  return {
    snapshot: () => store.snapshot(),
    hash: () => hashSnapshot(store.snapshot()),
    rngCalls: () => rng.calls(),
    apply(intent) {
      switch (intent.kind) {
        case 'move':
          return applyMove(ctx, intent);
        case 'traverse':
          return applyTraverse(ctx, intent);
        case 'attack':
          return applyAttack(ctx, intent);
        case 'end_turn':
          return applyEndTurn(ctx, intent);
        case 'pass_time':
          return applyPassTime(ctx, intent);
        case 'cast':
          return applyCast(ctx, intent);
        case 'say':
        case 'set_disposition':
        case 'spawn':
        case 'set_flag':
        case 'advance_quest':
        case 'author_map':
          return applyWorldIntent(ctx, intent);
        default:
          return reject(`Unknown intent ${String((intent as Intent).kind)}.`);
      }
    },
  };
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
  const diffs: Diff[] = [{ type: 'EntityMoved', entity: intent.entity, from, to, path: steps }];
  if (init) {
    const turn = economyOf(init);
    const spent = { ...turn, movedFt: turn.movedFt + steps.length * TILE_FEET };
    ctx.store.setInitiative({ ...init, turn: spent });
    diffs.push({ type: 'EconomySpent', entity: intent.entity, turn: spent });
  }
  return accept(diffs);
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

/**
 * Validate an attack completely. Reads only; never mutates and never rolls. `action` selects the
 * table the ability key is looked up in: weapons by default, spells for a `cast` intent.
 */
export function checkAttack(
  store: Store,
  intent: AttackIntent,
  action: AttackAction = WEAPON_ACTION,
): AttackCheck | Verdict {
  const actor = checkActor(store, intent.attacker, action.verb);
  if (isVerdict(actor)) return actor;
  const init = checkTurn(store, actor);
  if (isVerdict(init)) return init;
  const { entity, position, map } = actor;

  const weapon = action.lookup(intent.ability);
  if (!weapon) return reject(action.unknown(entity.name, intent.ability));
  if (!weapon.natural) {
    const held = entity.components.inventory?.items.some((i) => i.item === weapon.key && i.qty > 0);
    if (!held) return reject(action.missing(entity.name, weapon.name));
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

function applyAttack(
  ctx: EngineContext,
  intent: AttackIntent,
  action: AttackAction = WEAPON_ACTION,
): Verdict {
  const check = checkAttack(ctx.store, intent, action);
  if (isVerdict(check)) return check;
  const { actor, target, weapon, distanceFt, offhand } = check;

  const diffs: Diff[] = [];
  let init = check.init;
  if (!init) {
    // The first attack starts the encounter: initiative for everyone, the attacker acting first.
    init = startEncounter(ctx, actor.entity.id);
    diffs.push({
      type: 'TurnAdvanced',
      initiative: structuredClone(init),
      clock: ctx.store.clock(),
    });
  }

  const result: AttackResult = resolveAttack(ctx.rng, {
    attacker: { stats: actor.stats, health: actor.health },
    target: { stats: target.stats, health: target.health },
    weapon,
    distanceFt,
    hostileAdjacent: hostileAdjacent(ctx.store, actor),
    offhand,
  });

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
  const spent = offhand ? { ...turn, bonusActionUsed: true } : { ...turn, actionUsed: true };
  ctx.store.setInitiative({ ...init, turn: spent });
  diffs.push({ type: 'EconomySpent', entity: actor.entity.id, turn: spent });

  const facing = directionTo(actor.position, target.position);
  if (facing && facing !== actor.position.facing) {
    ctx.store.setComponent(actor.entity.id, 'position', { ...actor.position, facing });
    diffs.push({ type: 'FacingChanged', entity: actor.entity.id, facing });
  }
  return accept(diffs);
}

// ---------------------------------------------------------------------------------------------
// cast — the attack pipeline with a spell in place of the weapon
// ---------------------------------------------------------------------------------------------

/**
 * A spell attack is an attack: same range, line-of-sight, action-economy and roll path, with the
 * key looked up in the cantrip table instead of the weapon table. Deliberately not a second
 * implementation — `cast` must not be able to do anything `attack` could not.
 */
function applyCast(ctx: EngineContext, intent: CastIntent): Verdict {
  const asAttack: AttackIntent = {
    kind: 'attack',
    attacker: intent.caster,
    target: intent.target,
    ability: intent.spell,
  };
  return applyAttack(ctx, asAttack, SPELL_ACTION);
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
  return accept([
    { type: 'TurnAdvanced', initiative: structuredClone(next.state), clock: ctx.store.clock() },
  ]);
}

// ---------------------------------------------------------------------------------------------
// pass_time — the player waits, and the clock moves (ALE-41)
// ---------------------------------------------------------------------------------------------

/**
 * Validate a wait. Reads only. The mirror image of `checkEndTurn`: that one needs an encounter
 * and this one needs there not to be, so between them every moment in the world has exactly one
 * legal way to give the turn back, and neither ever had to change what the other says.
 */
export function checkPassTime(store: Store, intent: PassTimeIntent): Actor | Verdict {
  const actor = checkActor(store, intent.entity, 'wait');
  if (isVerdict(actor)) return actor;
  if (store.initiative()) {
    return reject(`An encounter is running; ${actor.entity.name} must end their turn instead.`);
  }
  return actor;
}

/**
 * One round of time passes. The only mutation is the clock — no initiative is started, no economy
 * is spent, nobody moves — so the diff is the `TurnAdvanced` the clock already travels in, with a
 * null initiative saying in so many words that this was not a turn in a fight.
 *
 * The clock is inside the state hash, so two waits in a row are two different worlds. That is what
 * stops the preview cache from answering the second one with the first one's answer, and what lets
 * an NPC notice that the player has been standing there a while.
 */
function applyPassTime(ctx: EngineContext, intent: PassTimeIntent): Verdict {
  const actor = checkPassTime(ctx.store, intent);
  if (isVerdict(actor)) return actor;
  ctx.store.setClock(ctx.store.clock() + 1);
  return accept([{ type: 'TurnAdvanced', initiative: null, clock: ctx.store.clock() }]);
}
