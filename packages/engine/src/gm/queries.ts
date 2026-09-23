import {
  TILE_FEET,
  type AttackIntent,
  type EntityId,
  type InitiativeState,
  type MapRecord,
  type Snapshot,
  type Tile,
  type TurnEconomy,
} from '@deliberate/protocol';

import {
  cellAt,
  distanceFeet,
  distanceTiles,
  feetToTiles,
  lineOfSight,
  path,
  reachable,
  tileKey,
} from '../grid/index.js';
import { attackSources, rollMode, type RollMode } from '../rules/attack.js';
import { isAlive } from '../rules/conditions.js';
import { defaultMap, isVerdict, occupiedTiles } from '../rules/context.js';
import { checkAttack } from '../rules/create-engine.js';
import { economyOf, freshEconomy } from '../rules/initiative.js';
import { abilityModifier } from '../rules/abilities.js';
import {
  attackAbility,
  WEAPON_ACTION,
  type AttackAction,
  type DiceExpr,
} from '../rules/weapons.js';
import { createStore, type Store } from '../store/index.js';
import { SPELLS, SPELL_ACTION } from './spells.js';

/**
 * The GM's query tools (ALE-31): `get_state`, `legal_actions`, `line_of_sight`, `path`, `recall`,
 * `roll_preview`.
 *
 * Every one of them is a pure function of a `Snapshot`. They work on `createStore(snapshot)` — a
 * deep copy the caller never sees — so a query cannot reach the engine's own store even by
 * accident, and none of them takes an `Rng`, so none of them can consume a die roll. Those two
 * properties are what make the queries free: asking a question can never change the answer to the
 * next one, and it can never change what the next real roll comes out as.
 */

/** A query that cannot be answered (unknown entity, ambiguous map). Caught by the executor. */
export class GmQueryError extends Error {
  override readonly name = 'GmQueryError';
}

function fail(reason: string): never {
  throw new GmQueryError(reason);
}

function storeOf(snapshot: Snapshot): Store {
  return createStore(snapshot);
}

function mapOf(store: Store, id: string | null): MapRecord {
  if (id !== null) {
    const map = store.getMap(id);
    if (!map) fail(`There is no map called ${id}.`);
    return map;
  }
  const map = defaultMap(store);
  if (isVerdict(map)) fail(map.reason ?? 'No map is loaded.');
  return map;
}

// ---------------------------------------------------------------------------------------------
// get_state
// ---------------------------------------------------------------------------------------------

export type GetStateScope = 'world' | 'entities' | 'initiative' | 'map' | 'all';

export interface GetStateArgs {
  scope: GetStateScope;
  entity_id: EntityId | null;
}

export function getState(snapshot: Snapshot, args: GetStateArgs): unknown {
  const store = storeOf(snapshot);
  switch (args.scope) {
    case 'world': {
      const world = store.world();
      return {
        clock: world.clock,
        flags: world.flags,
        quests: Object.values(world.quests)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((q) => ({ ...q, current: q.steps[q.step] ?? null })),
        maps: Object.keys(world.maps).sort(),
      };
    }
    case 'entities': {
      if (args.entity_id !== null) {
        const entity = store.getEntity(args.entity_id);
        if (!entity) fail(`There is no one called ${args.entity_id} here.`);
        return describeEntity(store, entity.id);
      }
      return store.entityIds().map((id) => describeEntity(store, id));
    }
    case 'initiative':
      return describeInitiative(store);
    case 'map':
      return describeMap(store, mapOf(store, null));
    case 'all':
      return {
        world: getState(snapshot, { scope: 'world', entity_id: null }),
        entities: store.entityIds().map((id) => describeEntity(store, id)),
        initiative: describeInitiative(store),
        map: describeMap(store, mapOf(store, null)),
      };
  }
}

/** An entity as the GM should see it: every component except the cosmetic ones. */
function describeEntity(store: Store, id: EntityId): unknown {
  const entity = store.getEntity(id)!;
  const { portrait: _portrait, ...components } = entity.components;
  return { id: entity.id, name: entity.name, alive: isAlive(entity.components.health), components };
}

function describeInitiative(store: Store): unknown {
  const init = store.initiative();
  if (!init) {
    return {
      encounter: false,
      note: 'No encounter is running; movement is free and nobody has a turn.',
    };
  }
  const current = init.order[init.current] ?? null;
  return {
    encounter: true,
    round: init.round,
    order: init.order.map((id) => ({ id, name: store.getEntity(id)?.name ?? id })),
    current,
    turn: economyOf(init),
  };
}

/**
 * The grid as ASCII, one string per row: `#` is impassable, `.` is floor, a digit is walkable
 * ground at that elevation. Far cheaper than shipping width*height cell objects, and an LLM reads
 * it far better.
 */
function describeMap(store: Store, map: MapRecord): unknown {
  const rows: string[] = [];
  for (let y = 0; y < map.height; y++) {
    let row = '';
    for (let x = 0; x < map.width; x++) {
      const cell = cellAt(map, { x, y });
      if (!cell || !cell.walkable) row += '#';
      else row += cell.elevation === 0 ? '.' : String(Math.min(9, cell.elevation));
    }
    rows.push(row);
  }
  const occupants = store
    .entityIds()
    .map((id) => ({ id, position: store.getComponent(id, 'position') }))
    .filter((o) => o.position?.map === map.id)
    .map((o) => ({ id: o.id, x: o.position!.x, y: o.position!.y }));
  return {
    id: map.id,
    width: map.width,
    height: map.height,
    tileFeet: TILE_FEET,
    legend: '# impassable, . floor at elevation 0, digit walkable at that elevation',
    rows,
    occupants,
  };
}

// ---------------------------------------------------------------------------------------------
// line_of_sight and path
// ---------------------------------------------------------------------------------------------

export interface TwoTileArgs {
  a: Tile;
  b: Tile;
  map: string | null;
}

export function lineOfSightQuery(snapshot: Snapshot, args: TwoTileArgs): unknown {
  const store = storeOf(snapshot);
  const map = mapOf(store, args.map);
  return {
    map: map.id,
    visible: lineOfSight(map, args.a, args.b),
    distanceFt: distanceFeet(args.a, args.b),
    distanceTiles: distanceTiles(args.a, args.b),
  };
}

export interface PathArgs extends TwoTileArgs {
  max_cost: number;
}

export function pathQuery(snapshot: Snapshot, args: PathArgs): unknown {
  const store = storeOf(snapshot);
  const map = mapOf(store, args.map);
  const blocked = occupiedTiles(store, map.id);
  const tiles = path(map, args.a, args.b, args.max_cost, { blocked });
  if (!tiles) {
    return {
      map: map.id,
      found: false,
      reason: `No route from ${tileKey(args.a)} to ${tileKey(args.b)} within ${args.max_cost} tiles.`,
    };
  }
  return { map: map.id, found: true, cost: tiles.length, costFt: tiles.length * TILE_FEET, tiles };
}

// ---------------------------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------------------------

export interface RecallArgs {
  topic: string;
  limit: number;
}

/**
 * What the world record already says about a topic. This is the engine's memory of established
 * fact — flags, quest steps, who exists — not the GM's narrative memory, which lives in the
 * service's memory blocks (ALE-15). Matching is a case-insensitive substring so the GM does not
 * have to guess exact keys.
 */
export function recall(snapshot: Snapshot, args: RecallArgs): unknown {
  const store = storeOf(snapshot);
  const needle = args.topic.trim().toLowerCase();
  const hits: { kind: string; id: string; detail: unknown }[] = [];
  const matches = (...fields: string[]): boolean =>
    fields.some((f) => f.toLowerCase().includes(needle));

  const world = store.world();
  for (const key of Object.keys(world.flags).sort()) {
    if (matches(key, String(world.flags[key]))) {
      hits.push({ kind: 'flag', id: key, detail: world.flags[key] });
    }
  }
  for (const id of Object.keys(world.quests).sort()) {
    const quest = world.quests[id]!;
    if (matches(id, quest.title, ...quest.steps)) {
      hits.push({
        kind: 'quest',
        id,
        detail: { title: quest.title, step: quest.step, steps: quest.steps },
      });
    }
  }
  for (const id of store.entityIds()) {
    const entity = store.getEntity(id)!;
    const seeds = entity.components.dialogue?.seeds ?? [];
    if (matches(id, entity.name, ...seeds)) {
      hits.push({
        kind: 'entity',
        id,
        detail: {
          name: entity.name,
          faction: entity.components.faction?.id ?? null,
          disposition: entity.components.disposition?.toward ?? {},
          seeds,
        },
      });
    }
  }
  return { topic: args.topic, total: hits.length, matches: hits.slice(0, args.limit) };
}

// ---------------------------------------------------------------------------------------------
// legal_actions
// ---------------------------------------------------------------------------------------------

export interface LegalActionsArgs {
  entity_id: EntityId;
}

interface Option {
  target: EntityId;
  name: string;
  ability: string;
  distanceFt: number;
  ok: boolean;
  reason?: string;
}

/**
 * Everything `entity_id` may legally do, answered by running the engine's own validators over a
 * copy of the state. Options the engine would refuse are listed with the refusal, so the GM can
 * see the shape of the turn instead of discovering it one rejected call at a time.
 */
export function legalActions(snapshot: Snapshot, args: LegalActionsArgs): unknown {
  const store = storeOf(snapshot);
  const entity = store.getEntity(args.entity_id);
  if (!entity) fail(`There is no one called ${args.entity_id} here.`);

  const init = store.initiative();
  const turn = turnOf(store, init, entity.id);
  const position = entity.components.position;
  const stats = entity.components.stats;
  const map = position ? store.getMap(position.map) : undefined;

  let move: unknown = { ok: false, reason: `${entity.name} is not on a map.` };
  if (position && stats && map) {
    const remainingFt = init ? stats.speed - economyOf(init).movedFt : stats.speed;
    const budget = feetToTiles(remainingFt);
    const blocked = occupiedTiles(store, position.map, entity.id);
    const tiles = [...reachable(map, position, Math.max(0, budget), { blocked }).values()]
      .sort((a, b) => a.cost - b.cost || a.tile.x - b.tile.x || a.tile.y - b.tile.y)
      .map((r) => ({ ...r.tile, costFt: r.cost * TILE_FEET }));
    move = { ok: tiles.length > 0, remainingFt, tiles };
  }

  const attack: Option[] = [];
  const cast: Option[] = [];
  const inventory = entity.components.inventory?.items ?? [];
  const weaponKeys = ['unarmed', ...inventory.filter((i) => i.qty > 0).map((i) => i.item)];
  const spellKeys = inventory
    .filter((i) => i.qty > 0 && Object.hasOwn(SPELLS, i.item))
    .map((i) => i.item);
  for (const targetId of store.entityIds()) {
    if (targetId === entity.id) continue;
    const target = store.getEntity(targetId)!;
    const tPos = target.components.position;
    if (!tPos || !position || tPos.map !== position.map) continue;
    const distanceFt = distanceFeet(position, tPos);
    for (const key of weaponKeys) {
      if (Object.hasOwn(SPELLS, key)) continue;
      attack.push(option(store, entity.id, targetId, target.name, key, distanceFt, WEAPON_ACTION));
    }
    for (const key of spellKeys) {
      cast.push(option(store, entity.id, targetId, target.name, key, distanceFt, SPELL_ACTION));
    }
  }

  return {
    entity: entity.id,
    name: entity.name,
    turn,
    move,
    attack,
    cast,
    say: {
      ok: isAlive(entity.components.health),
      note: 'Speaking is always free and changes no state.',
    },
    end_turn: init
      ? { ok: init.order[init.current] === entity.id }
      : { ok: false, reason: 'No encounter is running; there is no turn to end.' },
  };
}

function option(
  store: Store,
  attacker: EntityId,
  target: EntityId,
  targetName: string,
  ability: string,
  distanceFt: number,
  action: AttackAction,
): Option {
  const intent: AttackIntent = { kind: 'attack', attacker, target, ability };
  const check = checkAttack(store, intent, action);
  if (isVerdict(check)) {
    return { target, name: targetName, ability, distanceFt, ok: false, reason: check.reason! };
  }
  return { target, name: targetName, ability, distanceFt, ok: true };
}

function turnOf(
  store: Store,
  init: InitiativeState | null,
  id: EntityId,
): { encounter: boolean; isTheirTurn: boolean; economy: TurnEconomy | null } {
  void store;
  if (!init) return { encounter: false, isTheirTurn: false, economy: null };
  const isTheirTurn = init.order[init.current] === id;
  return { encounter: true, isTheirTurn, economy: isTheirTurn ? economyOf(init) : freshEconomy() };
}

// ---------------------------------------------------------------------------------------------
// roll_preview — odds without a roll
// ---------------------------------------------------------------------------------------------

export interface RollPreviewArgs {
  action: { kind: 'attack' | 'cast'; attacker: EntityId; target: EntityId; ability: string };
}

/**
 * The odds of an attack, computed from the rules rather than sampled.
 *
 * This is the one query where getting it wrong would be invisible and fatal: if a preview drew
 * from the seeded RNG, the next real roll would differ from the one the recording replays, the
 * state hashes would diverge, and determinism — the engine's hard requirement and M0's exit
 * criterion — would be gone. So there is no `Rng` in scope here at all: the hit chance is a
 * closed-form count over the twenty faces of a d20, and the expected damage is the average of the
 * damage dice. Nothing is sampled, nothing is cloned, nothing advances.
 */
export function rollPreview(snapshot: Snapshot, args: RollPreviewArgs): unknown {
  const store = storeOf(snapshot);
  const { kind, attacker, target, ability } = args.action;
  const action = kind === 'cast' ? SPELL_ACTION : WEAPON_ACTION;
  const intent: AttackIntent = { kind: 'attack', attacker, target, ability };
  const check = checkAttack(store, intent, action);
  if (isVerdict(check)) return { legal: false, reason: check.reason };

  const ctx = {
    attacker: { stats: check.actor.stats, health: check.actor.health },
    target: { stats: check.target.stats, health: check.target.health },
    weapon: check.weapon,
    distanceFt: check.distanceFt,
    hostileAdjacent: hostileAdjacent(store, check.actor.entity.id),
    offhand: check.offhand,
  };
  const sources = attackSources(ctx);
  const mode = rollMode(sources);
  const abilityUsed = attackAbility(check.weapon, check.actor.stats);
  const attackBonus =
    abilityModifier(check.actor.stats, abilityUsed) + check.actor.stats.proficiency;
  const targetAc = check.target.stats.ac;

  const single = hitFaces(attackBonus, targetAc) / 20;
  const hitChance = combine(single, mode);
  const critChance = combine(1 / 20, mode);
  const damageMod = check.weapon.noAbilityDamage
    ? 0
    : check.offhand
      ? Math.min(abilityModifier(check.actor.stats, abilityUsed), 0)
      : abilityModifier(check.actor.stats, abilityUsed);
  const normalDamage = Math.max(0, average(check.weapon.damage, 1) + damageMod);
  const critDamage = Math.max(0, average(check.weapon.damage, 2) + damageMod);
  const expectedDamage = (hitChance - critChance) * normalDamage + critChance * critDamage;

  return {
    legal: true,
    kind,
    attacker,
    target,
    ability: check.weapon.key,
    mode,
    advantage: sources.advantage,
    disadvantage: sources.disadvantage,
    attackBonus,
    targetAc,
    /** Natural roll that hits, ignoring the automatic 20 and automatic 1. */
    needsNatural: Math.max(2, Math.min(20, targetAc - attackBonus)),
    hitChance: round3(hitChance),
    critChance: round3(critChance),
    averageDamageOnHit: round3(normalDamage),
    averageDamageOnCrit: round3(critDamage),
    expectedDamage: round3(expectedDamage),
    targetHp: check.target.health.hp,
    note: 'Odds only. No die was rolled and the seeded stream did not move.',
  };
}

/** How many of the twenty d20 faces hit: a natural 20 always, a natural 1 never. */
function hitFaces(attackBonus: number, targetAc: number): number {
  const need = Math.max(2, Math.min(21, targetAc - attackBonus));
  return Math.max(0, 20 - need) + 1;
}

/** Advantage is "at least one of two"; disadvantage is "both". */
function combine(p: number, mode: RollMode): number {
  if (mode === 'advantage') return 1 - (1 - p) * (1 - p);
  if (mode === 'disadvantage') return p * p;
  return p;
}

/** Mean of a dice expression: each dN averages (N + 1) / 2. */
function average(dice: DiceExpr, times: number): number {
  const faces = dice.sides > 0 ? ((dice.sides + 1) / 2) * dice.count * times : 0;
  return faces + (dice.flat ?? 0);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Mirrors the rules layer: a living enemy within 5 ft, which makes a ranged attack harder. */
function hostileAdjacent(store: Store, id: EntityId): boolean {
  const position = store.getComponent(id, 'position');
  const faction = store.getComponent(id, 'faction')?.id;
  if (!position) return false;
  for (const other of store.entityIds()) {
    if (other === id) continue;
    const pos = store.getComponent(other, 'position');
    if (!pos || pos.map !== position.map) continue;
    if (distanceFeet(pos, position) > TILE_FEET) continue;
    if (!isAlive(store.getComponent(other, 'health'))) continue;
    if (store.getComponent(other, 'faction')?.id === faction) continue;
    return true;
  }
  return false;
}
