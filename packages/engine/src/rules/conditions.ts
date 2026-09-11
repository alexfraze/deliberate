import type { Condition, Health } from '@deliberate/protocol';

/**
 * The condition subset the trimmed rules understand. `Condition` stays a string in the protocol so
 * other packages can carry conditions the engine does not act on yet; only these three change
 * legality or rolls.
 *
 * - `dead`: HP reached 0. Cannot act, cannot be targeted, skipped in initiative.
 * - `unconscious`: incapacitated; attacks against it have advantage.
 * - `prone`: attacks against it have advantage from within 5 ft and disadvantage from farther;
 *   its own attacks have disadvantage.
 */
export const CONDITIONS = ['dead', 'unconscious', 'prone'] as const;
export type KnownCondition = (typeof CONDITIONS)[number];

export function hasCondition(health: Pick<Health, 'conditions'>, condition: Condition): boolean {
  return health.conditions.includes(condition);
}

export function isAlive(health: Pick<Health, 'hp' | 'conditions'> | undefined): boolean {
  return !!health && health.hp > 0 && !hasCondition(health, 'dead');
}

/** Cannot take actions or move: dead or unconscious. */
export function isIncapacitated(health: Pick<Health, 'hp' | 'conditions'> | undefined): boolean {
  return !isAlive(health) || hasCondition(health!, 'unconscious');
}
