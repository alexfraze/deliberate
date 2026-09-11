import type {
  Condition,
  ConditionSet,
  DamageApplied,
  Diff,
  DialogueLine,
  Direction8,
  DispositionChanged,
  EconomySpent,
  Entity,
  EntityId,
  EntityMoved,
  EntitySpawned,
  FacingChanged,
  FlagSet,
  FlagValue,
  Health,
  InitiativeState,
  Position,
  QuestAdvanced,
  QuestId,
  Tile,
  TurnAdvanced,
  TurnEconomy,
  World,
} from '@deliberate/protocol';

/**
 * Constructors for the diff types, plus before/after helpers that turn a pair of component
 * values into the diffs that describe the change. The rules layer mutates the store and calls
 * these, so the wire shape lives in one place and `apply` in apply.ts stays its exact inverse.
 *
 * Pure and total: nothing here reads the store or validates legality (that happened before the
 * mutation) — these only describe what already changed.
 */

export function entityMoved(
  entity: EntityId,
  from: Tile,
  to: Tile,
  path: readonly Tile[],
): EntityMoved {
  return { type: 'EntityMoved', entity, from: { ...from }, to: { ...to }, path: path.map(tile) };
}

export function damageApplied(
  target: EntityId,
  amount: number,
  hpAfter: number,
  source: EntityId | null = null,
): DamageApplied {
  return { type: 'DamageApplied', target, amount, source, hpAfter };
}

export function conditionSet(
  entity: EntityId,
  condition: Condition,
  active: boolean,
): ConditionSet {
  return { type: 'ConditionSet', entity, condition, active };
}

export function dialogueLine(
  speaker: EntityId,
  text: string,
  to: EntityId | null = null,
): DialogueLine {
  return { type: 'DialogueLine', speaker, text, to };
}

export function flagSet(key: string, value: FlagValue): FlagSet {
  return { type: 'FlagSet', key, value };
}

export function entitySpawned(entity: Entity): EntitySpawned {
  return { type: 'EntitySpawned', entity: structuredClone(entity) };
}

export function turnAdvanced(initiative: InitiativeState | null, clock: number): TurnAdvanced {
  return { type: 'TurnAdvanced', initiative: structuredClone(initiative), clock };
}

export function economySpent(entity: EntityId, turn: TurnEconomy): EconomySpent {
  return { type: 'EconomySpent', entity, turn: { ...turn } };
}

export function facingChanged(entity: EntityId, facing: Direction8): FacingChanged {
  return { type: 'FacingChanged', entity, facing };
}

export function dispositionChanged(
  entity: EntityId,
  toward: EntityId,
  value: number,
  reason: string,
): DispositionChanged {
  return { type: 'DispositionChanged', entity, toward, value, reason };
}

export function questAdvanced(quest: QuestId, step: number): QuestAdvanced {
  return { type: 'QuestAdvanced', quest, step };
}

// ---------------------------------------------------------------------------------------------
// before/after helpers
// ---------------------------------------------------------------------------------------------

/**
 * The move that took `before` to `after`, or `null` when the entity did not change tile (a turn
 * in place is cosmetic and carries no diff). `path` defaults to a single step onto the tile.
 */
export function movedDiff(
  entity: EntityId,
  before: Position,
  after: Position,
  path?: readonly Tile[],
): EntityMoved | null {
  if (before.x === after.x && before.y === after.y) return null;
  return entityMoved(entity, tile(before), tile(after), path ?? [tile(after)]);
}

/**
 * Everything that changed about an entity's hit points: the damage taken (temporary hit points
 * included, which is why the amount is not simply the drop in `hp`) and every condition that
 * appeared or vanished, in a stable order so the stream is deterministic.
 */
export function healthDiffs(
  entity: EntityId,
  before: Health,
  after: Health,
  source: EntityId | null = null,
): Diff[] {
  const diffs: Diff[] = [];
  const amount = pool(before) - pool(after);
  if (amount > 0) diffs.push(damageApplied(entity, amount, after.hp, source));
  for (const condition of after.conditions) {
    if (!before.conditions.includes(condition)) diffs.push(conditionSet(entity, condition, true));
  }
  for (const condition of before.conditions) {
    if (!after.conditions.includes(condition)) diffs.push(conditionSet(entity, condition, false));
  }
  return diffs;
}

/** One `FlagSet` per world flag whose value changed, in sorted key order. */
export function flagDiffs(before: World['flags'], after: World['flags']): FlagSet[] {
  return Object.keys(after)
    .sort()
    .filter((key) => before[key] !== after[key])
    .map((key) => flagSet(key, after[key]!));
}

function tile(t: Tile): Tile {
  return { x: t.x, y: t.y };
}

/** Hit points a damage roll has to chew through: temporary first, then real. */
function pool(health: Health): number {
  return health.hp + (health.tempHp ?? 0);
}
