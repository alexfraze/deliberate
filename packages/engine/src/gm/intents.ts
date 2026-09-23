import type {
  AdvanceQuestIntent,
  AuthorMapIntent,
  Diff,
  Entity,
  EntityId,
  FlagValue,
  SayIntent,
  SetDispositionIntent,
  SetFlagIntent,
  SpawnIntent,
  Verdict,
} from '@deliberate/protocol';

import { inBounds, isWalkable, tileKey } from '../grid/index.js';
import { isAlive } from '../rules/conditions.js';
import {
  accept,
  defaultMap,
  describeTile,
  isVerdict,
  occupiedTiles,
  reject,
  type EngineContext,
} from '../rules/context.js';
import type { Store } from '../store/index.js';
import { authorMap } from './maps.js';

/**
 * The M1 intents that act on the world rather than on the grid: `say`, `set_disposition`,
 * `spawn`, `set_flag`, `advance_quest` (ALE-31), joined in M4 by `author_map`, which writes a
 * whole location and lives in `maps.ts` because its validation is the size of a module. `cast` is not here — it is a spell attack and
 * resolves through the existing attack pipeline in rules/create-engine.ts.
 *
 * These are ordinary engine intents, not a GM back door: `Engine.apply` dispatches to them and
 * the GM's tool calls reach them through exactly the same `apply` the player's UI uses.
 *
 * House rule shared by all of them: **a mutation that would change nothing is rejected.** Setting
 * a flag to the value it already has, or nudging a disposition that is already pinned at 100, is
 * a no-op, and a no-op verdict in the recording would be an empty diff pretending to be a change.
 * The rejection reason says what the value already is, which is information the GM wanted anyway.
 */
export function applyWorldIntent(
  ctx: EngineContext,
  intent:
    | SayIntent
    | SetDispositionIntent
    | SpawnIntent
    | SetFlagIntent
    | AdvanceQuestIntent
    | AuthorMapIntent,
): Verdict {
  switch (intent.kind) {
    case 'say':
      return applySay(ctx.store, intent);
    case 'set_disposition':
      return applySetDisposition(ctx.store, intent);
    case 'spawn':
      return applySpawn(ctx, intent);
    case 'set_flag':
      return applySetFlag(ctx.store, intent);
    case 'advance_quest':
      return applyAdvanceQuest(ctx.store, intent);
    case 'author_map':
      return authorMap(ctx, intent);
  }
}

// ---------------------------------------------------------------------------------------------
// say — the state no-op
// ---------------------------------------------------------------------------------------------

/**
 * Speaking changes nothing in the store: the verdict carries a `DialogueLine` and the state hash
 * is identical before and after. It is still validated, because the GM must not be able to put
 * words in the mouth of someone who is not here or is dead.
 */
function applySay(store: Store, intent: SayIntent): Verdict {
  const speaker = store.getEntity(intent.speaker);
  if (!speaker) return reject(`There is no one called ${intent.speaker} here.`);
  const health = speaker.components.health;
  if (health && !isAlive(health)) return reject(`${speaker.name} is dead and cannot speak.`);
  const text = intent.text.trim();
  if (!text) return reject(`${speaker.name} cannot say nothing.`);
  if (intent.to !== null && !store.hasEntity(intent.to)) {
    return reject(`There is no one called ${intent.to} for ${speaker.name} to speak to.`);
  }
  return accept([{ type: 'DialogueLine', speaker: intent.speaker, text, to: intent.to }]);
}

// ---------------------------------------------------------------------------------------------
// set_disposition
// ---------------------------------------------------------------------------------------------

const DISPOSITION_MIN = -100;
const DISPOSITION_MAX = 100;

function applySetDisposition(store: Store, intent: SetDispositionIntent): Verdict {
  const entity = store.getEntity(intent.entity);
  if (!entity) return reject(`There is no one called ${intent.entity} here.`);
  const toward = store.getEntity(intent.toward);
  if (!toward) return reject(`There is no one called ${intent.toward} here.`);
  if (intent.entity === intent.toward) {
    return reject(`${entity.name} cannot hold a disposition toward themself.`);
  }
  if (!Number.isInteger(intent.delta)) {
    return reject('A disposition change has to be a whole number.');
  }
  const reason = intent.reason.trim();
  if (!reason) return reject('A disposition change needs a reason; it goes into the ledger.');
  const disposition = store.getComponent(intent.entity, 'disposition');
  if (!disposition) return reject(`${entity.name} has no disposition to change.`);

  const before = disposition.toward[intent.toward] ?? 0;
  const value = Math.max(DISPOSITION_MIN, Math.min(DISPOSITION_MAX, before + intent.delta));
  if (value === before) {
    return reject(
      `${entity.name}'s disposition toward ${toward.name} is already ${before}; that change would do nothing.`,
    );
  }
  store.setComponent(intent.entity, 'disposition', {
    ...disposition,
    toward: { ...disposition.toward, [intent.toward]: value },
  });
  return accept([
    {
      type: 'DispositionChanged',
      entity: intent.entity,
      toward: intent.toward,
      value,
      reason,
    },
  ]);
}

// ---------------------------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------------------------

function applySpawn(ctx: EngineContext, intent: SpawnIntent): Verdict {
  const { store, templates } = ctx;
  const template = Object.hasOwn(templates, intent.template)
    ? templates[intent.template]
    : undefined;
  if (!template) {
    const known = Object.keys(templates).sort().join(', ');
    return reject(
      `There is no template called ${intent.template}.` +
        (known ? ` Known templates: ${known}.` : ' No templates are loaded.'),
    );
  }

  const map = intent.map === null ? defaultMap(store) : store.getMap(intent.map);
  if (map === undefined) return reject(`There is no map called ${intent.map}.`);
  if (isVerdict(map)) return map;
  if (!inBounds(map, intent.at)) return reject(`${describeTile(intent.at)} is off the map.`);
  if (!isWalkable(map, intent.at)) {
    return reject(`Nothing can stand on ${describeTile(intent.at)}.`);
  }
  if (occupiedTiles(store, map.id).has(tileKey(intent.at))) {
    return reject(`${describeTile(intent.at)} is occupied.`);
  }

  const id = intent.id ?? deriveId(store, intent.template);
  if (!id) return reject('A spawned entity needs an id.');
  if (store.hasEntity(id)) return reject(`An entity called ${id} is already here.`);

  const spawned: Entity = structuredClone(template);
  spawned.id = id;
  spawned.components.position = {
    ...(spawned.components.position ?? {}),
    map: map.id,
    x: intent.at.x,
    y: intent.at.y,
  };
  store.addEntity(spawned);

  const diffs: Diff[] = [{ type: 'EntitySpawned', entity: structuredClone(spawned) }];

  // A newcomer to a running encounter acts last in the round. Initiative totals are not kept on
  // the snapshot, so there is nothing to sort against; appending is the only ordering the engine
  // can justify, and it cannot disturb whose turn it is because `current` is always below the
  // old length. No die is rolled, so spawning does not shift the RNG stream.
  const init = store.initiative();
  if (init && spawned.components.stats && isAlive(spawned.components.health)) {
    const next = { ...init, order: [...init.order, id] };
    store.setInitiative(next);
    diffs.push({ type: 'TurnAdvanced', initiative: structuredClone(next), clock: store.clock() });
  }
  return accept(diffs);
}

/** `template-1`, `template-2`, … — the first that is free. Deterministic: no clock, no RNG. */
function deriveId(store: Store, template: string): EntityId {
  for (let n = 1; ; n++) {
    const candidate = `${template}-${n}`;
    if (!store.hasEntity(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------------------------
// set_flag
// ---------------------------------------------------------------------------------------------

function applySetFlag(store: Store, intent: SetFlagIntent): Verdict {
  const key = intent.key.trim();
  if (!key) return reject('A world flag needs a key.');
  if (!isFlagValue(intent.value)) {
    return reject(`Flag ${key} must be a boolean, a finite number or a string.`);
  }
  if (store.getFlag(key) === intent.value) {
    return reject(`Flag ${key} is already ${JSON.stringify(intent.value)}.`);
  }
  store.setFlag(key, intent.value);
  return accept([{ type: 'FlagSet', key, value: intent.value }]);
}

function isFlagValue(value: unknown): value is FlagValue {
  if (typeof value === 'boolean' || typeof value === 'string') return true;
  return typeof value === 'number' && Number.isFinite(value);
}

// ---------------------------------------------------------------------------------------------
// advance_quest
// ---------------------------------------------------------------------------------------------

function applyAdvanceQuest(store: Store, intent: AdvanceQuestIntent): Verdict {
  const quest = store.getQuest(intent.quest);
  if (!quest) return reject(`There is no quest called ${intent.quest}.`);
  if (!Number.isInteger(intent.step) || intent.step < 0 || intent.step >= quest.steps.length) {
    return reject(
      `"${quest.title}" has ${quest.steps.length} steps, numbered 0 to ${quest.steps.length - 1}; there is no step ${intent.step}.`,
    );
  }
  if (intent.step <= quest.step) {
    return reject(`"${quest.title}" is already at step ${quest.step}; quests only move forward.`);
  }
  store.advanceQuest(intent.quest, intent.step);
  return accept([{ type: 'QuestAdvanced', quest: intent.quest, step: intent.step }]);
}
