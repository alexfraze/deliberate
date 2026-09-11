import type { Stats } from '@deliberate/protocol';

/** The six SRD 5.1 abilities. */
export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type Ability = (typeof ABILITIES)[number];

/** SRD 5.1: modifier = floor((score - 10) / 2). 10–11 is +0, 8–9 is -1, 20 is +5. */
export function modifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function abilityModifier(stats: Pick<Stats, Ability>, ability: Ability): number {
  return modifier(stats[ability]);
}

/** Signed text for a modifier or bonus: "+3", "-1", "+0". */
export function signed(n: number): string {
  return n < 0 ? `${n}` : `+${n}`;
}
