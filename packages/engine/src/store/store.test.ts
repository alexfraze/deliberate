import type { Snapshot } from '@deliberate/protocol';
import { describe, expect, it } from 'vitest';

import { fixtureMap, fixtureSnapshot, FIXTURE_PLAYER_ID } from './fixtures.js';
import {
  createStore,
  emptySnapshot,
  snapshotFromJSON,
  StoreError,
  storeFromJSON,
} from './store.js';

describe('createStore', () => {
  it('does not alias the initial snapshot or leak live references on read', () => {
    const initial = fixtureSnapshot();
    const store = createStore(initial);
    initial.world.clock = 99;
    expect(store.clock()).toBe(0);

    const snap = store.snapshot();
    snap.entities[FIXTURE_PLAYER_ID]!.components.health!.hp = 1;
    expect(store.getComponent(FIXTURE_PLAYER_ID, 'health')?.hp).toBe(12);

    const health = store.getComponent(FIXTURE_PLAYER_ID, 'health')!;
    health.hp = 0;
    expect(store.getComponent(FIXTURE_PLAYER_ID, 'health')?.hp).toBe(12);

    const world = store.world();
    world.flags['tutorial'] = false;
    expect(store.getFlag('tutorial')).toBe(true);
  });

  it('copies written values so later edits by the caller do not reach the store', () => {
    const store = createStore();
    const entity = { id: 'e', name: 'E', components: {} };
    store.addEntity(entity);
    entity.name = 'changed';
    expect(store.getEntity('e')?.name).toBe('E');
    const inv = { items: [{ item: 'rope', qty: 1 }] };
    store.setComponent('e', 'inventory', inv);
    inv.items.push({ item: 'torch', qty: 3 });
    expect(store.getComponent('e', 'inventory')?.items).toHaveLength(1);
  });

  it('adds, gets, and removes components', () => {
    const store = createStore();
    store.addEntity({ id: 'e', name: 'E', components: {} });
    expect(store.hasComponent('e', 'health')).toBe(false);
    expect(store.getComponent('e', 'health')).toBeUndefined();

    store.setComponent('e', 'health', { hp: 5, maxHp: 5, conditions: [] });
    expect(store.hasComponent('e', 'health')).toBe(true);
    expect(store.getComponent('e', 'health')).toEqual({ hp: 5, maxHp: 5, conditions: [] });

    store.setComponent('e', 'health', { hp: 3, maxHp: 5, conditions: ['prone'] });
    expect(store.getComponent('e', 'health')?.hp).toBe(3);

    expect(store.removeComponent('e', 'health')).toBe(true);
    expect(store.removeComponent('e', 'health')).toBe(false);
    expect(store.hasComponent('e', 'health')).toBe(false);
    expect(store.getEntity('e')?.components).toEqual({});
  });

  it('refuses components on missing entities but tolerates reads', () => {
    const store = createStore();
    expect(() => store.setComponent('ghost', 'faction', { id: 'x' })).toThrow(StoreError);
    expect(() => store.removeComponent('ghost', 'faction')).toThrow(StoreError);
    expect(store.hasComponent('ghost', 'faction')).toBe(false);
    expect(store.getComponent('ghost', 'faction')).toBeUndefined();
  });

  it('adds, replaces, lists (sorted), and removes entities', () => {
    const store = createStore();
    store.addEntity({ id: 'b', name: 'B', components: {} });
    store.addEntity({ id: 'a', name: 'A', components: {} });
    expect(store.entityIds()).toEqual(['a', 'b']);
    store.addEntity({ id: 'a', name: 'A2', components: { faction: { id: 'f' } } });
    expect(store.getEntity('a')).toEqual({
      id: 'a',
      name: 'A2',
      components: { faction: { id: 'f' } },
    });
    expect(store.removeEntity('a')).toBe(true);
    expect(store.removeEntity('a')).toBe(false);
    expect(store.hasEntity('a')).toBe(false);
    expect(() => store.addEntity({ id: '', name: 'x', components: {} })).toThrow(StoreError);
  });

  it('manages the world record: flags, quests, clock, maps', () => {
    const store = createStore();
    store.setFlag('door', 'open');
    store.setFlag('count', 2);
    expect(store.getFlag('door')).toBe('open');
    expect(store.removeFlag('door')).toBe(true);
    expect(store.removeFlag('door')).toBe(false);
    expect(store.world().flags).toEqual({ count: 2 });

    store.setQuest({ id: 'q', title: 'Q', steps: ['a', 'b'], step: 0 });
    store.advanceQuest('q', 1);
    expect(store.getQuest('q')?.step).toBe(1);
    expect(() => store.advanceQuest('q', 2)).toThrow(StoreError);
    expect(() => store.advanceQuest('nope', 0)).toThrow(StoreError);
    expect(store.removeQuest('q')).toBe(true);
    expect(store.getQuest('q')).toBeUndefined();

    store.setClock(3);
    expect(store.clock()).toBe(3);

    const map = fixtureMap();
    store.setMap(map);
    expect(store.hasMap(map.id)).toBe(true);
    expect(store.getMap(map.id)).toEqual(map);
    expect(() => store.setMap({ ...map, cells: map.cells.slice(1) })).toThrow(StoreError);
    expect(store.removeMap(map.id)).toBe(true);
    expect(store.hasMap(map.id)).toBe(false);

    store.setInitiative({ order: ['a'], current: 0, round: 1 });
    const init = store.initiative()!;
    init.round = 7;
    expect(store.initiative()?.round).toBe(1);
    store.setInitiative(null);
    expect(store.initiative()).toBeNull();
  });
});

describe('JSON round-trip', () => {
  it('toJSON -> fromJSON reproduces the snapshot exactly', () => {
    const store = createStore(fixtureSnapshot());
    const text = store.toJSON();
    const again = storeFromJSON(text);
    expect(again.snapshot()).toEqual(store.snapshot());
    expect(again.toJSON()).toBe(text);
    expect(snapshotFromJSON(text)).toEqual(fixtureSnapshot());
  });

  it('rejects malformed input with a readable error', () => {
    expect(() => snapshotFromJSON('{')).toThrow(StoreError);
    expect(() => snapshotFromJSON('[]')).toThrow(/object/);
    expect(() => snapshotFromJSON(JSON.stringify({ ...emptySnapshot(), schema: 2 }))).toThrow(
      /schema/,
    );
    const badEntity: Snapshot = {
      ...emptySnapshot(),
      entities: { a: { id: 'b', name: 'x', components: {} } },
    };
    expect(() => snapshotFromJSON(JSON.stringify(badEntity))).toThrow(/mismatched id/);
    const unknown = JSON.parse(JSON.stringify(emptySnapshot()));
    unknown.entities.a = { id: 'a', name: 'A', components: { wings: {} } };
    expect(() => snapshotFromJSON(JSON.stringify(unknown))).toThrow(/unknown component wings/);
    const shortMap = fixtureSnapshot();
    shortMap.world.maps[fixtureMap().id]!.cells.pop();
    expect(() => createStore(shortMap)).toThrow(/cells/);
  });
});

describe('fixtures', () => {
  it('build a 12x12 map with walls and elevation, and a fresh snapshot each call', () => {
    const map = fixtureMap();
    expect(map.width).toBe(12);
    expect(map.height).toBe(12);
    expect(map.cells).toHaveLength(144);
    expect(map.cells.some((c) => !c.walkable)).toBe(true);
    expect(new Set(map.cells.map((c) => c.elevation)).size).toBeGreaterThan(2);
    const a = fixtureSnapshot();
    const b = fixtureSnapshot();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(Object.keys(a.entities)).toHaveLength(3);
    // Every entity stands on a walkable tile.
    for (const e of Object.values(a.entities)) {
      const p = e.components.position!;
      expect(map.cells[p.y * map.width + p.x]?.walkable).toBe(true);
    }
  });
});
