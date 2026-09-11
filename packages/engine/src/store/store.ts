import {
  PROTOCOL_VERSION,
  type ComponentName,
  type Components,
  type Entity,
  type EntityId,
  type FlagValue,
  type InitiativeState,
  type MapId,
  type MapRecord,
  type Quest,
  type QuestId,
  type Snapshot,
  type World,
} from '@deliberate/protocol';

/**
 * The entity store: the one place the engine keeps authoritative state. It wraps a `Snapshot`
 * and is the only thing allowed to mutate it. Every read returns a `structuredClone`, so callers
 * can never hold a live reference into the store; every write takes a clone of its argument for
 * the same reason.
 *
 * The store enforces referential integrity a snapshot needs to be well formed (an entity exists
 * before you attach a component to it) and throws `StoreError` when violated. It does not know
 * the game rules; legality of a move or an attack is the rules layer's job (ALE-9).
 */
export interface Store {
  /** Deep copy of the whole authoritative state. */
  snapshot(): Snapshot;

  // Entities
  entityIds(): EntityId[];
  hasEntity(id: EntityId): boolean;
  getEntity(id: EntityId): Entity | undefined;
  /** Adds or replaces the entity with the same id. */
  addEntity(entity: Entity): void;
  /** Returns true when an entity was removed. */
  removeEntity(id: EntityId): boolean;

  // Components
  hasComponent(id: EntityId, name: ComponentName): boolean;
  getComponent<K extends ComponentName>(id: EntityId, name: K): Components[K] | undefined;
  /** Adds or replaces a component. Throws when the entity does not exist. */
  setComponent<K extends ComponentName>(id: EntityId, name: K, value: Components[K]): void;
  /** Returns true when the component was present. Throws when the entity does not exist. */
  removeComponent(id: EntityId, name: ComponentName): boolean;

  // World record
  world(): World;
  getFlag(key: string): FlagValue | undefined;
  setFlag(key: string, value: FlagValue): void;
  removeFlag(key: string): boolean;
  getQuest(id: QuestId): Quest | undefined;
  setQuest(quest: Quest): void;
  removeQuest(id: QuestId): boolean;
  /** Sets `step` on a quest; throws when the quest is missing or the step is out of range. */
  advanceQuest(id: QuestId, step: number): void;
  clock(): number;
  setClock(rounds: number): void;
  getMap(id: MapId): MapRecord | undefined;
  hasMap(id: MapId): boolean;
  setMap(map: MapRecord): void;
  removeMap(id: MapId): boolean;

  // Initiative
  initiative(): InitiativeState | null;
  setInitiative(state: InitiativeState | null): void;

  /** Canonical JSON text of the snapshot (deterministic key order is the hash's job, not this). */
  toJSON(): string;
}

export class StoreError extends Error {
  override readonly name = 'StoreError';
}

/** A well-formed snapshot with nothing in it. */
export function emptySnapshot(): Snapshot {
  return {
    schema: PROTOCOL_VERSION,
    entities: {},
    world: { flags: {}, quests: {}, clock: 0, maps: {} },
    initiative: null,
  };
}

const COMPONENT_NAMES: readonly ComponentName[] = [
  'position',
  'stats',
  'health',
  'inventory',
  'faction',
  'disposition',
  'brain',
  'dialogue',
  'portrait',
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Structural check that `value` is a `Snapshot`. Deliberately shallow on component internals
 * (the protocol types are the contract); deep enough that a garbage file fails loudly instead of
 * crashing the engine later.
 */
export function assertSnapshot(value: unknown): asserts value is Snapshot {
  if (!isRecord(value)) throw new StoreError('snapshot must be an object');
  if (value['schema'] !== PROTOCOL_VERSION) {
    throw new StoreError(`snapshot schema ${String(value['schema'])} != ${PROTOCOL_VERSION}`);
  }
  if (!isRecord(value['entities'])) throw new StoreError('snapshot.entities must be an object');
  for (const [id, entity] of Object.entries(value['entities'])) {
    if (!isRecord(entity)) throw new StoreError(`entity ${id} must be an object`);
    if (entity['id'] !== id) throw new StoreError(`entity ${id} has mismatched id`);
    if (typeof entity['name'] !== 'string') throw new StoreError(`entity ${id} needs a name`);
    if (!isRecord(entity['components'])) {
      throw new StoreError(`entity ${id}.components must be an object`);
    }
    for (const name of Object.keys(entity['components'])) {
      if (!(COMPONENT_NAMES as readonly string[]).includes(name)) {
        throw new StoreError(`entity ${id} has unknown component ${name}`);
      }
    }
  }
  const world = value['world'];
  if (!isRecord(world)) throw new StoreError('snapshot.world must be an object');
  if (!isRecord(world['flags'])) throw new StoreError('world.flags must be an object');
  if (!isRecord(world['quests'])) throw new StoreError('world.quests must be an object');
  if (typeof world['clock'] !== 'number') throw new StoreError('world.clock must be a number');
  if (!isRecord(world['maps'])) throw new StoreError('world.maps must be an object');
  for (const [id, map] of Object.entries(world['maps'])) {
    if (!isRecord(map) || map['id'] !== id) throw new StoreError(`map ${id} has mismatched id`);
    const { width, height, cells } = map;
    if (typeof width !== 'number' || typeof height !== 'number' || !Array.isArray(cells)) {
      throw new StoreError(`map ${id} needs width, height and cells`);
    }
    if (cells.length !== width * height) {
      throw new StoreError(`map ${id} has ${cells.length} cells, expected ${width * height}`);
    }
  }
  const init = value['initiative'];
  if (init !== null) {
    if (!isRecord(init) || !Array.isArray(init['order'])) {
      throw new StoreError('snapshot.initiative must be null or have an order');
    }
    if (typeof init['current'] !== 'number' || typeof init['round'] !== 'number') {
      throw new StoreError('snapshot.initiative needs current and round');
    }
  }
}

/** Parse JSON text into a validated snapshot. */
export function snapshotFromJSON(text: string): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new StoreError(`snapshot is not valid JSON: ${(e as Error).message}`);
  }
  assertSnapshot(parsed);
  return parsed;
}

/** Wrap a snapshot in a store. The store owns a deep copy; the caller's object is untouched. */
export function createStore(initial: Snapshot = emptySnapshot()): Store {
  assertSnapshot(initial);
  const state: Snapshot = structuredClone(initial);

  const mustEntity = (id: EntityId): Entity => {
    const e = state.entities[id];
    if (!e) throw new StoreError(`no entity ${id}`);
    return e;
  };

  return {
    snapshot: () => structuredClone(state),

    entityIds: () => Object.keys(state.entities).sort(),
    hasEntity: (id) => Object.hasOwn(state.entities, id),
    getEntity: (id) => structuredClone(state.entities[id]),
    addEntity(entity) {
      if (!entity.id) throw new StoreError('entity needs an id');
      state.entities[entity.id] = structuredClone(entity);
    },
    removeEntity(id) {
      if (!Object.hasOwn(state.entities, id)) return false;
      delete state.entities[id];
      return true;
    },

    hasComponent: (id, name) => Object.hasOwn(state.entities[id]?.components ?? {}, name),
    getComponent: (id, name) => structuredClone(state.entities[id]?.components[name]),
    setComponent(id, name, value) {
      mustEntity(id).components[name] = structuredClone(value);
    },
    removeComponent(id, name) {
      const e = mustEntity(id);
      if (!Object.hasOwn(e.components, name)) return false;
      delete e.components[name];
      return true;
    },

    world: () => structuredClone(state.world),
    getFlag: (key) => state.world.flags[key],
    setFlag(key, value) {
      state.world.flags[key] = value;
    },
    removeFlag(key) {
      if (!Object.hasOwn(state.world.flags, key)) return false;
      delete state.world.flags[key];
      return true;
    },
    getQuest: (id) => structuredClone(state.world.quests[id]),
    setQuest(quest) {
      state.world.quests[quest.id] = structuredClone(quest);
    },
    removeQuest(id) {
      if (!Object.hasOwn(state.world.quests, id)) return false;
      delete state.world.quests[id];
      return true;
    },
    advanceQuest(id, step) {
      const q = state.world.quests[id];
      if (!q) throw new StoreError(`no quest ${id}`);
      if (!Number.isInteger(step) || step < 0 || step >= q.steps.length) {
        throw new StoreError(`quest ${id} has no step ${step}`);
      }
      q.step = step;
    },
    clock: () => state.world.clock,
    setClock(rounds) {
      state.world.clock = rounds;
    },
    getMap: (id) => structuredClone(state.world.maps[id]),
    hasMap: (id) => Object.hasOwn(state.world.maps, id),
    setMap(map) {
      if (map.cells.length !== map.width * map.height) {
        throw new StoreError(
          `map ${map.id} has ${map.cells.length} cells, expected ${map.width * map.height}`,
        );
      }
      state.world.maps[map.id] = structuredClone(map);
    },
    removeMap(id) {
      if (!Object.hasOwn(state.world.maps, id)) return false;
      delete state.world.maps[id];
      return true;
    },

    initiative: () => structuredClone(state.initiative),
    setInitiative(init) {
      state.initiative = structuredClone(init);
    },

    toJSON: () => JSON.stringify(state),
  };
}

/** Rebuild a store from `toJSON()` output. */
export function storeFromJSON(text: string): Store {
  return createStore(snapshotFromJSON(text));
}
