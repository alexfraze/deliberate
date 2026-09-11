import type { Health, Stats } from '@deliberate/protocol';

import { abilityModifier } from './abilities.js';
import { hasCondition } from './conditions.js';
import type { Rng } from './rng.js';
import { attackAbility, isRangedAttack, type DiceExpr, type Weapon } from './weapons.js';

export type RollMode = 'normal' | 'advantage' | 'disadvantage';

export interface AttackContext {
  attacker: { stats: Stats; health: Health };
  target: { stats: Stats; health: Health };
  weapon: Weapon;
  distanceFt: number;
  /** A hostile, non-incapacitated creature stands within 5 ft of the attacker (ranged penalty). */
  hostileAdjacent: boolean;
  /** Off-hand bonus-action attack: no positive ability modifier to damage. */
  offhand: boolean;
}

export interface AttackSources {
  advantage: string[];
  disadvantage: string[];
}

/**
 * SRD 5.1 advantage/disadvantage sources the trimmed rules track. Any number of each still
 * collapses to one; one of each cancels to a normal roll.
 */
export function attackSources(ctx: AttackContext): AttackSources {
  const advantage: string[] = [];
  const disadvantage: string[] = [];
  const ranged = isRangedAttack(ctx.weapon, ctx.distanceFt);
  const t = ctx.target.health;
  const a = ctx.attacker.health;
  if (hasCondition(t, 'unconscious')) advantage.push('target unconscious');
  if (hasCondition(t, 'prone')) {
    if (ctx.distanceFt <= 5) advantage.push('target prone');
    else disadvantage.push('target prone at range');
  }
  if (hasCondition(a, 'prone')) disadvantage.push('attacker prone');
  if (ranged) {
    if (ctx.hostileAdjacent) disadvantage.push('hostile within 5 ft');
    if (ctx.weapon.rangeFt && ctx.distanceFt > ctx.weapon.rangeFt.normal) {
      disadvantage.push('long range');
    }
  }
  return { advantage, disadvantage };
}

export function rollMode(sources: AttackSources): RollMode {
  const adv = sources.advantage.length > 0;
  const dis = sources.disadvantage.length > 0;
  if (adv === dis) return 'normal';
  return adv ? 'advantage' : 'disadvantage';
}

/** Rolls the d20(s) for `mode` and returns the one that counts plus everything rolled. */
export function rollD20(rng: Rng, mode: RollMode): { natural: number; rolled: number[] } {
  const first = rng.roll(20);
  if (mode === 'normal') return { natural: first, rolled: [first] };
  const second = rng.roll(20);
  const natural = mode === 'advantage' ? Math.max(first, second) : Math.min(first, second);
  return { natural, rolled: [first, second] };
}

export function rollDice(rng: Rng, dice: DiceExpr, times = 1): number {
  let total = dice.flat ?? 0;
  for (let i = 0; i < dice.count * times; i++) total += rng.roll(dice.sides);
  return total;
}

export interface AttackResult {
  mode: RollMode;
  sources: AttackSources;
  /** The d20 that counted. 20 always hits (critical), 1 always misses. */
  natural: number;
  rolled: number[];
  attackBonus: number;
  total: number;
  targetAc: number;
  hit: boolean;
  critical: boolean;
  /** Damage dealt on a hit (0 on a miss). Never negative. */
  damage: number;
}

/**
 * One attack roll and, on a hit, its damage, pulling every number from `rng` in a fixed order:
 * d20 (twice under advantage or disadvantage), then damage dice (doubled on a critical).
 * Pure apart from the rng; applying the damage is the engine's job.
 */
export function resolveAttack(rng: Rng, ctx: AttackContext): AttackResult {
  const sources = attackSources(ctx);
  const mode = rollMode(sources);
  const ability = attackAbility(ctx.weapon, ctx.attacker.stats);
  const mod = abilityModifier(ctx.attacker.stats, ability);
  const attackBonus = mod + ctx.attacker.stats.proficiency;
  const { natural, rolled } = rollD20(rng, mode);
  const total = natural + attackBonus;
  const targetAc = ctx.target.stats.ac;
  const critical = natural === 20;
  const hit = critical || (natural !== 1 && total >= targetAc);
  let damage = 0;
  if (hit) {
    const dice = rollDice(rng, ctx.weapon.damage, critical ? 2 : 1);
    // Cantrips add no ability modifier; an off-hand weapon adds only a negative one.
    const damageMod = ctx.weapon.noAbilityDamage ? 0 : ctx.offhand ? Math.min(mod, 0) : mod;
    damage = Math.max(0, dice + damageMod);
  }
  return { mode, sources, natural, rolled, attackBonus, total, targetAc, hit, critical, damage };
}

/** Apply `damage` to `health` SRD-style: temporary HP first, then HP, floored at 0. */
export function applyDamage(health: Health, damage: number): Health {
  let remaining = damage;
  let tempHp = health.tempHp ?? 0;
  if (tempHp > 0) {
    const absorbed = Math.min(tempHp, remaining);
    tempHp -= absorbed;
    remaining -= absorbed;
  }
  const hp = Math.max(0, health.hp - remaining);
  const next: Health = { ...health, hp };
  if (health.tempHp !== undefined) next.tempHp = tempHp;
  return next;
}
