import type { Diff, Entity } from '@deliberate/protocol';
import { describe, expect, it } from 'vitest';

import { fixtureSnapshot } from './fixtures/index.js';
import {
  applyDiffToView,
  applyDiffsToView,
  emptyView,
  entitiesHere,
  isAlive,
  viewFromSnapshot,
} from './view.js';

describe('viewFromSnapshot', () => {
  it('keeps only what a frame needs, and finds the map', () => {
    const view = viewFromSnapshot(fixtureSnapshot());
    expect(view.mapId).toBe('m0-yard');
    expect(view.map?.width).toBe(12);
    expect(Object.keys(view.entities).sort()).toEqual(['dummy-a', 'dummy-b', 'player']);
    expect(view.entities.player).toMatchObject({ faction: 'party', tile: { x: 2, y: 2 }, hp: 12 });
  });

  it('does not alias the snapshot it was built from', () => {
    const snapshot = fixtureSnapshot();
    const view = viewFromSnapshot(snapshot);
    applyDiffsToView(view, [
      {
        type: 'EntityMoved',
        entity: 'player',
        from: { x: 2, y: 2 },
        to: { x: 4, y: 2 },
        path: [{ x: 4, y: 2 }],
      },
    ]);
    expect(snapshot.entities.player?.components.position).toMatchObject({ x: 2, y: 2 });
  });

  it('skips entities with no position and copes with an empty snapshot', () => {
    const snapshot = fixtureSnapshot();
    const ghost: Entity = { id: 'ghost', name: 'Ghost', components: {} };
    snapshot.entities.ghost = ghost;
    expect(viewFromSnapshot(snapshot).entities.ghost).toBeUndefined();
    expect(emptyView()).toEqual({
      mapId: null,
      map: null,
      maps: {},
      player: null,
      entities: {},
      initiative: null,
    });
  });
});

/**
 * ALE-43: the crossing the renderer has to be able to tell from a walk. What the client draws is
 * wherever the player character is standing, and everyone left behind stops being drawn without
 * being forgotten — the initiative panel still has to be able to name them.
 */
describe('crossing between maps', () => {
  function twoMaps() {
    const snapshot = fixtureSnapshot();
    snapshot.world.maps['m0-cellar'] = {
      id: 'm0-cellar',
      width: 2,
      height: 2,
      cells: Array.from({ length: 4 }, () => ({ elevation: 0, walkable: true })),
    };
    return snapshot;
  }

  const crossing: Diff = {
    type: 'EntityTraversed',
    entity: 'player',
    fromMap: 'm0-yard',
    from: { x: 2, y: 2 },
    toMap: 'm0-cellar',
    to: { x: 1, y: 1 },
  };

  it('renders the map the player character is standing on', () => {
    const view = viewFromSnapshot(twoMaps());
    expect(view.player).toBe('player');
    expect(view.mapId).toBe('m0-yard');
    expect(Object.keys(view.maps).sort()).toEqual(['m0-cellar', 'm0-yard']);
    expect(
      entitiesHere(view)
        .map((e) => e.id)
        .sort(),
    ).toEqual(['dummy-a', 'dummy-b', 'player']);
  });

  it('swaps the board when the player crosses, and leaves the cast behind', () => {
    const view = viewFromSnapshot(twoMaps());
    applyDiffToView(view, crossing);
    expect(view.mapId).toBe('m0-cellar');
    expect(view.map?.width).toBe(2);
    expect(view.entities.player).toMatchObject({ map: 'm0-cellar', tile: { x: 1, y: 1 } });
    // Left behind, not forgotten: still in `entities`, simply not on this board.
    expect(entitiesHere(view).map((e) => e.id)).toEqual(['player']);
    expect(view.entities['dummy-a']?.map).toBe('m0-yard');
  });

  it('does not swap the board when somebody else crosses', () => {
    const view = viewFromSnapshot(twoMaps());
    applyDiffToView(view, { ...crossing, entity: 'dummy-a' });
    expect(view.mapId).toBe('m0-yard');
    expect(view.entities['dummy-a']?.map).toBe('m0-cellar');
    expect(
      entitiesHere(view)
        .map((e) => e.id)
        .sort(),
    ).toEqual(['dummy-b', 'player']);
  });

  it('is absolute: folding the same crossing twice lands where once did', () => {
    const view = viewFromSnapshot(twoMaps());
    applyDiffsToView(view, [crossing, crossing]);
    expect(view.mapId).toBe('m0-cellar');
    expect(view.entities.player).toMatchObject({ map: 'm0-cellar', tile: { x: 1, y: 1 } });
  });
});

describe('applyDiffsToView', () => {
  it('folds every diff type the protocol defines', () => {
    const view = viewFromSnapshot(fixtureSnapshot());
    const diffs: Diff[] = [
      {
        type: 'EntityMoved',
        entity: 'player',
        from: { x: 2, y: 2 },
        to: { x: 7, y: 3 },
        path: [{ x: 7, y: 3 }],
      },
      { type: 'DamageApplied', target: 'dummy-a', amount: 10, source: 'player', hpAfter: 0 },
      { type: 'ConditionSet', entity: 'dummy-a', condition: 'prone', active: true },
      { type: 'ConditionSet', entity: 'dummy-b', condition: 'prone', active: false },
      { type: 'DialogueLine', speaker: 'dummy-b', text: 'oi', to: null },
      { type: 'FlagSet', key: 'tutorial', value: false },
      {
        type: 'EntitySpawned',
        entity: {
          id: 'rat',
          name: 'Rat',
          components: {
            position: { map: 'm0-yard', x: 5, y: 5 },
            faction: { id: 'vermin' },
            health: { hp: 3, maxHp: 3, conditions: [] },
          },
        },
      },
    ];
    applyDiffsToView(view, diffs);

    expect(view.entities.player?.tile).toEqual({ x: 7, y: 3 });
    const dummyA = view.entities['dummy-a'];
    expect(dummyA?.hp).toBe(0);
    expect(dummyA && isAlive(dummyA)).toBe(false);
    expect(view.entities['dummy-a']?.conditions).toEqual(['prone']);
    expect(view.entities['dummy-b']?.conditions).toEqual([]);
    expect(view.entities.rat).toMatchObject({ faction: 'vermin', tile: { x: 5, y: 5 }, hp: 3 });
  });

  it('ignores diffs about entities it has never seen', () => {
    const view = viewFromSnapshot(fixtureSnapshot());
    const before = structuredClone(view.entities);
    applyDiffsToView(view, [
      { type: 'DamageApplied', target: 'nobody', amount: 1, source: null, hpAfter: 0 },
      { type: 'ConditionSet', entity: 'nobody', condition: 'prone', active: true },
      {
        type: 'EntityMoved',
        entity: 'nobody',
        from: { x: 0, y: 0 },
        to: { x: 1, y: 1 },
        path: [{ x: 1, y: 1 }],
      },
    ]);
    expect(view.entities).toEqual(before);
  });

  it('does not add a condition twice', () => {
    const view = viewFromSnapshot(fixtureSnapshot());
    const set: Diff = { type: 'ConditionSet', entity: 'player', condition: 'prone', active: true };
    applyDiffsToView(view, [set, set]);
    expect(view.entities.player?.conditions).toEqual(['prone']);
  });
});

describe('applyDiffToView, turn order', () => {
  it('tracks whose turn it is and what they have spent, from diffs alone', () => {
    const view = emptyView();
    const initiative = {
      order: ['player', 'dummy-a'],
      current: 0,
      round: 1,
      turn: { movedFt: 0, actionUsed: false, bonusActionUsed: false },
    };
    applyDiffToView(view, { type: 'TurnAdvanced', initiative, clock: 0 });
    expect(view.initiative).toEqual(initiative);
    expect(view.initiative).not.toBe(initiative); // the diff is never held by reference

    applyDiffToView(view, {
      type: 'EconomySpent',
      entity: 'player',
      turn: { movedFt: 15, actionUsed: true, bonusActionUsed: false },
    });
    expect(view.initiative!.turn).toEqual({
      movedFt: 15,
      actionUsed: true,
      bonusActionUsed: false,
    });

    applyDiffToView(view, { type: 'TurnAdvanced', initiative: null, clock: 2 });
    expect(view.initiative).toBeNull();
    // An economy spend with no encounter running is ignored rather than throwing.
    applyDiffToView(view, {
      type: 'EconomySpent',
      entity: 'player',
      turn: { movedFt: 5, actionUsed: false, bonusActionUsed: false },
    });
    expect(view.initiative).toBeNull();
  });
});
