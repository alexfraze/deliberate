import { type AttackAction, type Weapon } from '../rules/weapons.js';

/**
 * The trimmed cantrip table (ALE-31). Every entry is an attack cantrip — a ranged spell attack
 * roll against AC — which is exactly the shape the weapon pipeline already resolves, so `cast`
 * reuses it rather than growing a second combat implementation.
 *
 * Two SRD 5.1 details are carried by the `Weapon` record: `noAbilityDamage` (cantrips add no
 * ability modifier to damage) and the absence of `natural`, which makes the engine require the
 * spell in the caster's inventory. That inventory entry is the "known spells" list: content
 * (ALE-16) gives a caster `{ item: 'fire_bolt', qty: 1 }` and nobody else can cast it.
 */
export const SPELLS: Readonly<Record<string, Weapon>> = {
  fire_bolt: {
    key: 'fire_bolt',
    name: 'fire bolt',
    ability: 'int',
    damage: { count: 1, sides: 10 },
    rangeFt: { normal: 120, long: 120 },
    noAbilityDamage: true,
  },
  ray_of_frost: {
    key: 'ray_of_frost',
    name: 'ray of frost',
    ability: 'int',
    damage: { count: 1, sides: 8 },
    rangeFt: { normal: 60, long: 60 },
    noAbilityDamage: true,
  },
  eldritch_blast: {
    key: 'eldritch_blast',
    name: 'eldritch blast',
    ability: 'cha',
    damage: { count: 1, sides: 10 },
    rangeFt: { normal: 120, long: 120 },
    noAbilityDamage: true,
  },
};

export function getSpell(key: string): Weapon | undefined {
  return Object.hasOwn(SPELLS, key) ? SPELLS[key] : undefined;
}

/** Spell attacks: the cantrip table above, known when the caster's inventory lists the spell. */
export const SPELL_ACTION: AttackAction = {
  verb: 'cast',
  lookup: getSpell,
  unknown: (actor, key) => `${actor} does not know a spell called ${key}.`,
  missing: (actor, name) => `${actor} does not know ${name}.`,
};
