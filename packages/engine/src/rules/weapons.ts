import type { Ability } from './abilities.js';

export interface DiceExpr {
  /** Number of dice; 0 means a flat amount (unarmed strike deals 1). */
  count: number;
  sides: number;
  /** Flat bonus added once, before the ability modifier. */
  flat?: number;
}

export interface Weapon {
  key: string;
  name: string;
  /**
   * Which ability powers the attack. `finesse` picks the better of STR and DEX. Widened to all
   * six abilities in ALE-31 so an attack cantrip (INT, WIS or CHA) resolves through this same
   * record instead of needing a parallel spell pipeline.
   */
  ability: Ability | 'finesse';
  damage: DiceExpr;
  /** Melee reach in feet (5 for everything in the trimmed table). */
  reachFt?: number;
  /** Ranged weapons: normal and long range in feet. Beyond normal is disadvantage. */
  rangeFt?: { normal: number; long: number };
  /** Light weapons may be used for the bonus-action off-hand attack. */
  light?: boolean;
  /** Free: the inventory does not need to hold it. */
  natural?: boolean;
  /** SRD 5.1 cantrips add no ability modifier to damage, unlike weapons. ALE-31. */
  noAbilityDamage?: boolean;
}

/**
 * How an attack-shaped action names itself (ALE-31). `attack` and `cast` resolve through the one
 * pipeline — range, line of sight, action economy, a single seeded roll — and differ only in
 * which table the key is looked up in and what the rejections call it. Keeping the difference to
 * this record is what stops `cast` becoming a second, unvalidated way to deal damage.
 */
export interface AttackAction {
  /** Fills "<name> is dead and cannot ___". */
  verb: string;
  lookup(key: string): Weapon | undefined;
  /** Rejection when the key is in no table at all. */
  unknown(actor: string, key: string): string;
  /** Rejection when the actor does not carry (or know) it. */
  missing(actor: string, name: string): string;
}

/**
 * Trimmed SRD 5.1 weapon table: enough to give the MVP melee, finesse, light (off-hand), and
 * ranged options. Keys are what `AttackIntent.ability` carries and what `Inventory` items are
 * named.
 */
export const WEAPONS: Readonly<Record<string, Weapon>> = {
  unarmed: {
    key: 'unarmed',
    name: 'unarmed strike',
    ability: 'str',
    damage: { count: 0, sides: 0, flat: 1 },
    reachFt: 5,
    natural: true,
  },
  club: {
    key: 'club',
    name: 'club',
    ability: 'str',
    damage: { count: 1, sides: 4 },
    reachFt: 5,
    light: true,
  },
  dagger: {
    key: 'dagger',
    name: 'dagger',
    ability: 'finesse',
    damage: { count: 1, sides: 4 },
    reachFt: 5,
    rangeFt: { normal: 20, long: 60 },
    light: true,
  },
  handaxe: {
    key: 'handaxe',
    name: 'handaxe',
    ability: 'str',
    damage: { count: 1, sides: 6 },
    reachFt: 5,
    light: true,
  },
  mace: { key: 'mace', name: 'mace', ability: 'str', damage: { count: 1, sides: 6 }, reachFt: 5 },
  shortsword: {
    key: 'shortsword',
    name: 'shortsword',
    ability: 'finesse',
    damage: { count: 1, sides: 6 },
    reachFt: 5,
    light: true,
  },
  longsword: {
    key: 'longsword',
    name: 'longsword',
    ability: 'str',
    damage: { count: 1, sides: 8 },
    reachFt: 5,
  },
  greataxe: {
    key: 'greataxe',
    name: 'greataxe',
    ability: 'str',
    damage: { count: 1, sides: 12 },
    reachFt: 5,
  },
  shortbow: {
    key: 'shortbow',
    name: 'shortbow',
    ability: 'dex',
    damage: { count: 1, sides: 6 },
    rangeFt: { normal: 80, long: 320 },
  },
  longbow: {
    key: 'longbow',
    name: 'longbow',
    ability: 'dex',
    damage: { count: 1, sides: 8 },
    rangeFt: { normal: 150, long: 600 },
  },
};

export function getWeapon(key: string): Weapon | undefined {
  return Object.hasOwn(WEAPONS, key) ? WEAPONS[key] : undefined;
}

/** Which ability a weapon uses for a given attacker; finesse takes the higher score. */
export function attackAbility(weapon: Weapon, stats: Record<Ability, number>): Ability {
  if (weapon.ability === 'finesse') return stats.dex > stats.str ? 'dex' : 'str';
  return weapon.ability;
}

/** True when the weapon can attack from `distanceFt` at all (melee reach or ranged long range). */
export function inRange(weapon: Weapon, distanceFt: number): boolean {
  const reach = weapon.reachFt ?? 0;
  const long = weapon.rangeFt?.long ?? 0;
  return distanceFt <= Math.max(reach, long);
}

export function isRangedAttack(weapon: Weapon, distanceFt: number): boolean {
  return distanceFt > (weapon.reachFt ?? 0) && weapon.rangeFt !== undefined;
}

/** Weapon attacks: the SRD table above, carried in the inventory. */
export const WEAPON_ACTION: AttackAction = {
  verb: 'attack',
  lookup: getWeapon,
  unknown: (actor, key) => `${actor} does not know how to attack with ${key}.`,
  missing: (actor, name) => `${actor} does not have a ${name}.`,
};
