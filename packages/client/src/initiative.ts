/**
 * The turn-order indicator, as pure data (ALE-19).
 *
 * Initiative used to be one line of HUD text, which meant that in a fight you could not see whose
 * turn it was at a glance — it was legible only if you read a sentence. This turns `ViewState`
 * into the rows a strip of chips renders, and nothing else: no DOM, no three.js, so the ordering
 * and the "who is up next" arithmetic are unit-testable under node.
 *
 * Every field here is derived from the diff stream the client already folds (`TurnAdvanced`,
 * `EconomySpent`, `DamageApplied`, `ConditionSet`). Nothing is asked of the server.
 */
import type { EntityId, InitiativeState } from '@deliberate/protocol';

import { isAlive, type ViewState } from './view.js';

export interface InitiativeChip {
  id: EntityId;
  name: string;
  faction: string;
  hp: number;
  maxHp: number;
  /** Whose turn it is right now. Exactly one chip has this, unless the order is empty. */
  current: boolean;
  /** The next living entity to act. Null when nobody else is standing. */
  next: boolean;
  /** Out of the fight: `hp` is gone, or a `dead`/`unconscious` condition landed. */
  down: boolean;
  /** Present on the current chip only: what the acting entity has left to spend. */
  economy: string | null;
}

export interface InitiativeView {
  round: number;
  chips: InitiativeChip[];
}

/** Conditions that take an entity out of the turn order without removing it from `order`. */
const DOWN_CONDITIONS = new Set(['dead', 'dying', 'unconscious']);

function isDown(view: ViewState, id: EntityId): boolean {
  const entity = view.entities[id];
  if (!entity) return true;
  return !isAlive(entity) || entity.conditions.some((c) => DOWN_CONDITIONS.has(c));
}

/**
 * The next entity to act: the first one still standing after `current`, wrapping. Returns null
 * when nobody else is up — a one-sided fight, or an order of one.
 */
export function nextUp(initiative: InitiativeState, isDownAt: (id: EntityId) => boolean): number {
  const size = initiative.order.length;
  for (let step = 1; step < size; step += 1) {
    const index = (initiative.current + step) % size;
    const id = initiative.order[index];
    if (id !== undefined && !isDownAt(id)) return index;
  }
  return -1;
}

/** What the acting entity has left this turn, short enough to sit under a name. */
export function describeEconomy(initiative: InitiativeState): string {
  const spent = initiative.turn;
  if (!spent) return 'action · bonus';
  const left = [
    spent.actionUsed ? null : 'action',
    spent.bonusActionUsed ? null : 'bonus',
    spent.movedFt > 0 ? `${spent.movedFt} ft` : null,
  ].filter((part): part is string => part !== null);
  return left.length > 0 ? left.join(' · ') : 'spent';
}

/**
 * The strip, or null outside an encounter — which is the honest answer, because outside one there
 * is no initiative at all and nothing takes a turn.
 *
 * The order is the engine's, unrotated: a chip that jumped to the front every turn would be
 * harder to track across a round, not easier. The highlight moves instead.
 */
export function initiativeView(view: ViewState): InitiativeView | null {
  const initiative = view.initiative;
  if (!initiative || initiative.order.length === 0) return null;
  const next = nextUp(initiative, (id) => isDown(view, id));
  const chips = initiative.order.map((id, index) => {
    const entity = view.entities[id];
    const current = index === initiative.current;
    return {
      id,
      name: entity?.name ?? id,
      faction: entity?.faction ?? 'neutral',
      hp: entity?.hp ?? 0,
      maxHp: Math.max(1, entity?.maxHp ?? 1),
      current,
      next: index === next,
      down: isDown(view, id),
      economy: current ? describeEconomy(initiative) : null,
    };
  });
  return { round: initiative.round, chips };
}

/** Width of a chip's health bar, 0–1. Clamped, so a stray negative hp cannot invert it. */
export function healthFraction(chip: InitiativeChip): number {
  return Math.min(1, Math.max(0, chip.hp / chip.maxHp));
}
