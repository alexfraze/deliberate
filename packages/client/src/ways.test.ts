import type { MapRecord } from '@deliberate/protocol';
import { describe, expect, it } from 'vitest';

import {
  describeWay,
  describeWayHover,
  describeWaysMode,
  summariseWays,
  wayAt,
  waysOf,
  type Way,
} from './ways.js';

/**
 * The live world, exactly as it shipped: the two maps the player was lost in when they filed
 * ALE-51. Both labels below are the authored strings — they are the whole point of the issue, so
 * the test asserts on the real ones rather than on invented stand-ins.
 */
function gatehouse(): MapRecord {
  return {
    id: 'm1-gatehouse',
    width: 14,
    height: 12,
    cells: Array.from({ length: 14 * 12 }, () => ({ elevation: 0, walkable: true })),
    exits: [
      {
        at: { x: 1, y: 10 },
        to: 'm1-postern-lane',
        entrance: { x: 1, y: 0 },
        label: 'the postern lane',
      },
    ],
  };
}

function posternLane(): MapRecord {
  return {
    id: 'm1-postern-lane',
    width: 10,
    height: 7,
    cells: Array.from({ length: 10 * 7 }, () => ({ elevation: 0, walkable: true })),
    exits: [
      {
        at: { x: 1, y: 0 },
        to: 'm1-gatehouse',
        entrance: { x: 1, y: 10 },
        label: 'the gatehouse yard',
      },
    ],
    frontiers: [
      { at: { x: 8, y: 5 }, label: 'the lane running on east, out of sight past the spoil heap' },
    ],
  };
}

describe('waysOf', () => {
  it('surfaces the authored label of an exit', () => {
    const [way] = waysOf(gatehouse(), null);
    expect(way).toMatchObject({
      kind: 'exit',
      tile: { x: 1, y: 10 },
      label: 'the postern lane',
      here: false,
    });
  });

  it('lists exits and frontiers as different kinds', () => {
    const ways = waysOf(posternLane(), null);
    expect(ways.map((way) => way.kind)).toEqual(['exit', 'frontier']);
    expect(ways[1]?.label).toBe('the lane running on east, out of sight past the spoil heap');
  });

  it('puts whatever you are standing on first, because it is the only one you can act on', () => {
    const ways = waysOf(posternLane(), { x: 8, y: 5 });
    expect(ways[0]).toMatchObject({ kind: 'frontier', here: true });
    expect(ways[1]).toMatchObject({ kind: 'exit', here: false });
  });

  it('names an exit by its destination when it was authored without a label', () => {
    const map = gatehouse();
    delete map.exits![0]!.label;
    expect(waysOf(map, null)[0]?.label).toBe('m1-postern-lane');
  });

  it('is empty for a map with no way off it, and for no map at all', () => {
    const boxed = gatehouse();
    delete boxed.exits;
    expect(waysOf(boxed, null)).toEqual([]);
    expect(waysOf(null, { x: 0, y: 0 })).toEqual([]);
  });
});

describe('wayAt', () => {
  it('finds the way under a tile and nothing under a bare one', () => {
    expect(wayAt(posternLane(), { x: 8, y: 5 })?.kind).toBe('frontier');
    expect(wayAt(posternLane(), { x: 1, y: 0 })?.kind).toBe('exit');
    expect(wayAt(posternLane(), { x: 4, y: 3 })).toBeNull();
  });

  /**
   * Found by playing: hovering a door across the map told the player they were standing in it,
   * because the lookup used the hovered tile as the place you stand. "You are standing in it" is
   * the sentence that teaches the interaction, and it is worthless if it is said everywhere.
   */
  it('only says you are standing in it when you actually are', () => {
    const lane = posternLane();
    expect(wayAt(lane, { x: 8, y: 5 })?.here).toBe(false);
    expect(wayAt(lane, { x: 8, y: 5 }, { x: 4, y: 3 })?.here).toBe(false);
    expect(wayAt(lane, { x: 8, y: 5 }, { x: 8, y: 5 })?.here).toBe(true);
  });
});

describe('describeWay', () => {
  const exitHere: Way = {
    kind: 'exit',
    tile: { x: 1, y: 10 },
    label: 'the postern lane',
    here: true,
  };
  const exitThere: Way = { ...exitHere, here: false };

  /**
   * The sentence the whole issue turns on. `resolvePick` has taken a click on your own square as
   * taking the door under it since ALE-43, and nothing said so anywhere on screen.
   */
  it('says how to take an exit, both from on it and from across the map', () => {
    expect(describeWay(exitHere, true)).toContain('click your own tile');
    expect(describeWay(exitThere, true)).toContain('click your own tile');
    expect(describeWay(exitThere, true)).toContain('(1, 10)');
  });

  it('tells a player with deliberate mode off that a frontier will not open', () => {
    const frontier: Way = { kind: 'frontier', tile: { x: 8, y: 5 }, label: 'east', here: true };
    // ALE-39's lesson: the engine-only path has to say it is the engine-only path.
    expect(describeWay(frontier, false)).toContain('deliberate mode');
    expect(describeWay(frontier, true)).toContain('game master');
    expect(describeWay(frontier, true)).not.toContain('deliberate mode');
  });

  it('never tells you to click your own tile at a frontier — there is nothing to traverse to', () => {
    const frontier: Way = { kind: 'frontier', tile: { x: 8, y: 5 }, label: 'east', here: true };
    for (const on of [true, false]) {
      expect(describeWay(frontier, on)).not.toContain('click your own tile');
    }
  });
});

describe('describeWayHover', () => {
  it('names the kind and the label, so a hover answers "what is this tile"', () => {
    const way: Way = {
      kind: 'exit',
      tile: { x: 1, y: 10 },
      label: 'the postern lane',
      here: false,
    };
    const line = describeWayHover(way, true);
    expect(line).toContain('way out');
    expect(line).toContain('the postern lane');
  });

  it('calls a frontier a frontier and not a way out', () => {
    const way: Way = { kind: 'frontier', tile: { x: 8, y: 5 }, label: 'east', here: false };
    expect(describeWayHover(way, true)).toContain('frontier');
    expect(describeWayHover(way, true)).not.toContain('way out');
  });
});

describe('describeWaysMode', () => {
  const ways = waysOf(posternLane(), null);

  it('warns once, at the foot of the list, when a frontier cannot be crossed at all', () => {
    expect(describeWaysMode(ways, false)).toContain('game master');
    expect(describeWaysMode(ways, true)).toBeNull();
  });

  it('says nothing where there is no frontier to be blocked', () => {
    expect(describeWaysMode(waysOf(gatehouse(), null), false)).toBeNull();
    expect(describeWaysMode([], false)).toBeNull();
  });
});

describe('summariseWays', () => {
  it('counts what this board offers, so the arrival line answers "where can I go"', () => {
    expect(summariseWays(waysOf(posternLane(), null))).toBe(
      '1 way out and 1 frontier, ringed on the board and listed bottom right',
    );
    expect(summariseWays(waysOf(gatehouse(), null))).toContain('1 way out,');
  });

  it('says so plainly when there is nowhere to go, rather than nothing at all', () => {
    expect(summariseWays([])).toBe('no way off this map is marked');
  });
});
