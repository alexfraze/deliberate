import type { EntityId, InitiativeState, TurnEconomy } from '@deliberate/protocol';

import { abilityModifier } from './abilities.js';
import { isAlive } from './conditions.js';
import type { Rng } from './rng.js';
import type { Store } from '../store/index.js';

export function freshEconomy(): TurnEconomy {
  return { movedFt: 0, actionUsed: false, bonusActionUsed: false };
}

export function economyOf(init: InitiativeState): TurnEconomy {
  return init.turn ?? freshEconomy();
}

/** Entities that take part in an encounter: on a map, with stats, and alive. */
export function combatants(store: Store): EntityId[] {
  return store.entityIds().filter((id) => {
    const e = store.getEntity(id)!;
    return !!e.components.position && !!e.components.stats && isAlive(e.components.health);
  });
}

export interface InitiativeRoll {
  entity: EntityId;
  roll: number;
  total: number;
}

/**
 * SRD 5.1 initiative: d20 + DEX modifier per combatant, highest first. Ties break on DEX score,
 * then on entity id, so the order is a pure function of the rolls. Rolls are taken in id order
 * so the rng consumption is reproducible.
 */
export function rollInitiative(store: Store, rng: Rng): InitiativeRoll[] {
  const rolls = combatants(store).map((entity) => {
    const stats = store.getComponent(entity, 'stats')!;
    const roll = rng.roll(20);
    return { entity, roll, total: roll + abilityModifier(stats, 'dex'), dex: stats.dex };
  });
  rolls.sort((a, b) => b.total - a.total || b.dex - a.dex || (a.entity < b.entity ? -1 : 1));
  return rolls.map(({ entity, roll, total }) => ({ entity, roll, total }));
}

/** Whether `entity` may take a turn right now: alive and controllable. Dead ones are skipped. */
export function canTakeTurn(store: Store, entity: EntityId): boolean {
  const e = store.getEntity(entity);
  return !!e && isAlive(e.components.health);
}

/**
 * Brains whose turn is worth stopping on. `player` is the UI; `gm` is the game master, which the
 * server consults for that entity's turn (ALE-32). Everyone else — `none`, or no brain at all — is
 * scenery and is skipped, and when a whole cycle finds nobody the encounter ends.
 *
 * This is the one place the engine knows the game master exists, and it knows nothing about it
 * beyond the name: `advanceTurn` stops on a `gm` entity, and what happens next is the server's
 * business. Without it initiative would step straight over every NPC in `content/npcs`, which all
 * carry `brain.policy: 'gm'`, and no NPC would ever take a turn.
 */
export const ACTING_BRAIN_POLICIES: readonly string[] = ['player', 'gm'];

export function actsOnItsOwn(store: Store, entity: EntityId): boolean {
  const policy = store.getComponent(entity, 'brain')?.policy;
  return policy !== undefined && ACTING_BRAIN_POLICIES.includes(policy);
}

export interface TurnAdvance {
  state: InitiativeState | null;
  /** Rounds completed while advancing (the world clock moves by this much). */
  roundsPassed: number;
  /** Entities whose turns were skipped (dead, or no brain that can act in M0). */
  skipped: EntityId[];
}

/**
 * Move to the next entity that can act, wrapping to a new round when the order runs out and
 * skipping entities that cannot act. If a whole cycle finds nobody who can act on their own,
 * the encounter ends (`state: null`). Pure: returns a new state.
 */
export function advanceTurn(store: Store, init: InitiativeState): TurnAdvance {
  const n = init.order.length;
  let current = init.current;
  let round = init.round;
  let roundsPassed = 0;
  const skipped: EntityId[] = [];
  for (let i = 0; i < n; i++) {
    current += 1;
    if (current >= n) {
      current = 0;
      round += 1;
      roundsPassed += 1;
    }
    const id = init.order[current]!;
    if (canTakeTurn(store, id) && actsOnItsOwn(store, id)) {
      return {
        state: { order: init.order, current, round, turn: freshEconomy() },
        roundsPassed,
        skipped,
      };
    }
    skipped.push(id);
  }
  return { state: null, roundsPassed, skipped };
}
