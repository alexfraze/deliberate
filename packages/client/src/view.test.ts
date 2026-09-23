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

/**
 * ALE-48, the seam between ALE-43's board swap and ALE-44's authoring: **walking into a location
 * that did not exist when the session started**.
 *
 * `viewFromSnapshot` copies the maps that were loaded when the player joined, and the client is
 * given exactly one snapshot and a stream of diffs after it. So a location written mid-session
 * reaches the renderer only through `MapAuthored`, and if that diff is not folded, the crossing
 * into it sets `view.map` to null and the board goes blank — the one thing M4 promises a player,
 * silently not delivered, with the engine, the recording and the replay all perfectly correct.
 *
 * `links` matters just as much: the frontier tile the player is standing on only becomes a door
 * the UI will let them click once the map they are standing on carries the new exit.
 */
describe('walking into a location that did not exist', () => {
  const authored: Diff = {
    type: 'MapAuthored',
    map: {
      id: 'm0-spoil-rise',
      width: 3,
      height: 3,
      cells: Array.from({ length: 9 }, () => ({ elevation: 0, walkable: true })),
      entrance: { x: 1, y: 1 },
      exits: [{ at: { x: 1, y: 1 }, to: 'm0-yard', entrance: { x: 4, y: 4 }, label: 'the yard' }],
      frontiers: [{ at: { x: 2, y: 2 }, label: 'the slope going on up' }],
      objectives: [],
    },
    links: [
      {
        map: 'm0-yard',
        exits: [
          { at: { x: 4, y: 4 }, to: 'm0-spoil-rise', entrance: { x: 1, y: 1 }, label: 'the rise' },
        ],
        frontiers: [],
      },
    ],
  };

  it('adds the authored map to the boards the client can render', () => {
    const view = viewFromSnapshot(fixtureSnapshot());
    applyDiffToView(view, authored);
    expect(Object.keys(view.maps).sort()).toEqual(['m0-spoil-rise', 'm0-yard']);
    expect(view.maps['m0-spoil-rise']?.width).toBe(3);
    // The board under the player's feet has not changed; authoring is not a crossing.
    expect(view.mapId).toBe('m0-yard');
  });

  it('opens the door on the map the player is standing on', () => {
    const view = viewFromSnapshot(fixtureSnapshot());
    applyDiffToView(view, authored);
    // Without this the frontier tile is still just a tile: the inspector says nothing and the
    // click that should take the door does nothing.
    expect(view.maps['m0-yard']?.exits).toEqual([
      { at: { x: 4, y: 4 }, to: 'm0-spoil-rise', entrance: { x: 1, y: 1 }, label: 'the rise' },
    ]);
    expect(view.maps['m0-yard']?.frontiers).toEqual([]);
    // The rendered board is that same record, so the door opens on the map being drawn and not
    // only in the registry beside it.
    expect(view.map?.exits?.[0]?.to).toBe('m0-spoil-rise');
  });

  it('renders the new board when the player walks onto it', () => {
    const view = viewFromSnapshot(fixtureSnapshot());
    applyDiffsToView(view, [
      authored,
      {
        type: 'EntityTraversed',
        entity: 'player',
        fromMap: 'm0-yard',
        from: { x: 4, y: 4 },
        toMap: 'm0-spoil-rise',
        to: { x: 1, y: 1 },
      },
    ]);
    expect(view.mapId).toBe('m0-spoil-rise');
    // The whole gate, in one assertion: there is a board to draw.
    expect(view.map?.width).toBe(3);
    expect(entitiesHere(view).map((e) => e.id)).toEqual(['player']);
  });

  it('is absolute: folding the same authoring twice lands where once did', () => {
    const view = viewFromSnapshot(fixtureSnapshot());
    applyDiffsToView(view, [authored]);
    const once = structuredClone(view.maps);
    applyDiffsToView(view, [authored]);
    expect(view.maps).toEqual(once);
  });

  it('does not alias the diff it was folded from', () => {
    const view = viewFromSnapshot(fixtureSnapshot());
    const diff = structuredClone(authored);
    applyDiffToView(view, diff);
    view.maps['m0-spoil-rise']!.width = 99;
    expect((diff as typeof authored).map.width).toBe(3);
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
