export { ABILITIES, abilityModifier, modifier, signed, type Ability } from './abilities.js';
export {
  applyDamage,
  attackSources,
  resolveAttack,
  rollD20,
  rollDice,
  rollMode,
  type AttackContext,
  type AttackResult,
  type AttackSources,
  type RollMode,
} from './attack.js';
export {
  CONDITIONS,
  hasCondition,
  isAlive,
  isIncapacitated,
  type KnownCondition,
} from './conditions.js';
export {
  accept,
  checkActor,
  checkTurn,
  describeTile,
  isVerdict,
  occupiedTiles,
  reject,
  soleMap,
  type Actor,
  type EngineContext,
} from './context.js';
export {
  checkAttack,
  checkEndTurn,
  checkMove,
  checkPassTime,
  createEngine,
} from './create-engine.js';
export {
  ACTING_BRAIN_POLICIES,
  actsOnItsOwn,
  advanceTurn,
  canTakeTurn,
  combatants,
  economyOf,
  freshEconomy,
  rollInitiative,
  type InitiativeRoll,
  type TurnAdvance,
} from './initiative.js';
export { createRng, type Rng } from './rng.js';
export {
  attackAbility,
  getWeapon,
  inRange,
  isRangedAttack,
  WEAPON_ACTION,
  WEAPONS,
  type AttackAction,
  type DiceExpr,
  type Weapon,
} from './weapons.js';
