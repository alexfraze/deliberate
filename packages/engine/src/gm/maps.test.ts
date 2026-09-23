import {
  GM_TOOLS,
  type AuthorMapIntent,
  type MapFrontier,
  type MapObjective,
  type MapWayIn,
  type Snapshot,
  type Tile,
} from '@deliberate/protocol';
import { describe, expect, it } from 'vitest';

import { apply } from '../diffs/index.js';
import type { Engine } from '../engine.js';
import { createRecorder } from '../recorder/recorder.js';
import { replay } from '../recorder/replay.js';
import { memorySink } from '../recorder/sink.js';
import { createEngine } from '../rules/create-engine.js';
import { FIXTURE_MAP_ID, FIXTURE_SEED, fixtureSnapshot } from '../store/index.js';
import { executeGmTool } from './execute.js';
import { MAX_AUTHORED_MAP_SIZE, MIN_AUTHORED_MAP_SIZE } from './maps.js';

/**
 * ALE-44. Two things are being proved here, and the second is the one that has bitten this
 * project before.
 *
 * 1. **The validator refuses.** A validator that only ever passes is worthless, so every rule in
 *    `maps.ts` has a broken map written against it below — the walled-off objective, the map
 *    whose cell count lies, the one that exits to a map that does not exist — and every refusal
 *    is asserted to leave the world byte-identical, by state hash rather than by poking at
 *    fields. If any rejected path wrote before it checked, the hash moves and the test fails.
 *
 * 2. **Replay never calls the model.** The authored map's bytes ride in the `MapAuthored` diff
 *    and in the recorded intent, so a session containing an authoring replays from the engine
 *    alone: no key, no network, no Python. The miniature version of this bug already shipped once
 *    — `RecordingHeader` omitted the `templates` table and every session containing a `spawn`
 *    silently failed to replay (ALE-21) — and a generated map is the same bug with more surface.
 */

/** The yard's undefined edge: a gap in the north wall that leads nowhere yet. */
const YARD_FRONTIER: Tile = { x: 10, y: 1 };

/** The M0 fixture, given one undefined edge so there is somewhere to write beyond. */
function worldWithFrontier(): Snapshot {
  const snapshot = fixtureSnapshot();
  const yard = snapshot.world.maps[FIXTURE_MAP_ID]!;
  yard.frontiers = [{ at: { ...YARD_FRONTIER }, label: 'a gap in the north wall' }];
  return snapshot;
}

function engineWithFrontier(): Engine {
  return createEngine(worldWithFrontier(), { seed: FIXTURE_SEED });
}

/**
 * 8x6. Floor everywhere except a sealed 1x1 chamber at (3, 3) with no way in — the dead space the
 * `disconnected` rule exists for, and where the walled-off objective goes.
 */
const SEALED_ROWS = ['########', '#......#', '#.###..#', '#.#.#..#', '#.###..#', '########'];

/** The same shape with the chamber opened up, which is the map that should be accepted. */
const OPEN_ROWS = ['########', '#......#', '#......#', '#......#', '#......#', '########'];

const WAY_BACK: MapWayIn = {
  at: { x: 6, y: 4 },
  to: FIXTURE_MAP_ID,
  arrive: { ...YARD_FRONTIER },
  label: 'the gap back into the yard',
};

const NEW_FRONTIER: MapFrontier = {
  at: { x: 1, y: 1 },
  label: 'a track running west into the trees',
};

const MILESTONE: MapObjective = {
  at: { x: 5, y: 1 },
  note: 'a milestone, half-buried',
  quest: null,
};

function authoring(overrides: Partial<AuthorMapIntent> = {}): AuthorMapIntent {
  return {
    kind: 'author_map',
    id: 'north-road',
    width: 8,
    height: 6,
    terrain: [...OPEN_ROWS],
    back: structuredClone(WAY_BACK),
    frontiers: [structuredClone(NEW_FRONTIER)],
    objectives: [structuredClone(MILESTONE)],
    ...overrides,
  };
}

// -----------------------------------------------------------------------------------------------
// The world grows
// -----------------------------------------------------------------------------------------------

describe('author_map writes a location that did not exist at session start', () => {
  it('accepts a checkable map and links it to the frontier it was written beyond', () => {
    const engine = engineWithFrontier();
    expect(Object.keys(engine.snapshot().world.maps)).toEqual([FIXTURE_MAP_ID]);

    const verdict = engine.apply(authoring());
    expect(verdict.reason).toBeUndefined();
    expect(verdict.ok).toBe(true);

    const world = engine.snapshot().world;
    expect(Object.keys(world.maps).sort()).toEqual([FIXTURE_MAP_ID, 'north-road']);

    const road = world.maps['north-road']!;
    expect(road.cells).toHaveLength(8 * 6);
    expect(road.entrance).toEqual({ x: 6, y: 4 });
    expect(road.objectives).toEqual([MILESTONE]);

    // The yard's undefined edge is now a door, and it is gone from the frontier list: the two
    // sides agree by construction, because the engine wrote ALE-43's pair of exits itself rather
    // than trusting the model to describe both ends the same way.
    expect(world.maps[FIXTURE_MAP_ID]!.exits).toEqual([
      {
        at: YARD_FRONTIER,
        to: 'north-road',
        entrance: { x: 6, y: 4 },
        label: 'a gap in the north wall',
      },
    ]);
    expect(world.maps[FIXTURE_MAP_ID]!.frontiers).toEqual([]);
    expect(road.exits).toEqual([
      {
        at: { x: 6, y: 4 },
        to: FIXTURE_MAP_ID,
        entrance: YARD_FRONTIER,
        label: 'the gap back into the yard',
      },
    ]);
    expect(road.frontiers).toEqual([NEW_FRONTIER]);
  });

  it('emits one MapAuthored diff carrying the map bytes, and apply() reproduces the engine', () => {
    const engine = engineWithFrontier();
    const before = engine.snapshot();
    const verdict = engine.apply(authoring());
    expect(verdict.ok).toBe(true);
    expect(verdict.diff).toHaveLength(1);

    const diff = verdict.diff[0]!;
    expect(diff.type).toBe('MapAuthored');
    if (diff.type !== 'MapAuthored') throw new Error('unreachable');
    // The bytes are in the diff, not a reference to something a model would have to regenerate.
    expect(diff.map.cells).toHaveLength(48);
    expect(diff.links).toEqual([
      {
        map: FIXTURE_MAP_ID,
        exits: [
          {
            at: YARD_FRONTIER,
            to: 'north-road',
            entrance: { x: 6, y: 4 },
            label: 'a gap in the north wall',
          },
        ],
        frontiers: [],
      },
    ]);

    // The diff-driven path (the client, the replay checks) lands exactly where the engine did.
    expect(apply(before, verdict.diff)).toEqual(engine.snapshot());
    // Absolute, like every other diff: folding it twice lands where folding it once did.
    expect(apply(apply(before, verdict.diff), verdict.diff)).toEqual(engine.snapshot());
  });

  it('reaches the engine through the tool contract, schema and all', () => {
    const engine = engineWithFrontier();
    const result = executeGmTool(engine, {
      name: 'author_map',
      args: {
        map_id: 'north-road',
        width: 8,
        height: 6,
        terrain: [...OPEN_ROWS],
        back: { at: [6, 4], to: FIXTURE_MAP_ID, arrive: [10, 1], label: 'the gap back' },
        frontiers: [{ at: [1, 1], label: 'a track running west' }],
        objectives: [{ at: [5, 1], note: 'a milestone, half-buried', quest: null }],
      },
    });
    expect(result.reason).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(engine.snapshot().world.maps['north-road']).toBeDefined();
  });

  it('the contract bounds are the engine bounds', () => {
    const tool = GM_TOOLS.find((t) => t.name === 'author_map')!;
    for (const side of ['width', 'height'] as const) {
      const schema = tool.input_schema.properties![side]!;
      expect(schema.minimum).toBe(MIN_AUTHORED_MAP_SIZE);
      expect(schema.maximum).toBe(MAX_AUTHORED_MAP_SIZE);
    }
  });
});

// -----------------------------------------------------------------------------------------------
// Replay stays model-free
// -----------------------------------------------------------------------------------------------

describe('a session that authored a location replays from the engine alone', () => {
  it('replays hash for hash with no key, no network and no Python', () => {
    const start = worldWithFrontier();
    const engine = createEngine(structuredClone(start), { seed: FIXTURE_SEED });
    const sink = memorySink();
    const recorder = createRecorder(engine, {
      seed: FIXTURE_SEED,
      startedAt: '2026-01-01T00:00:00.000Z',
      sink,
    });

    // Walk a little, write the road, walk again: the authoring sits inside an ordinary session.
    expect(recorder.apply({ kind: 'move', entity: 'player', to: { x: 4, y: 2 } }).ok).toBe(true);
    expect(recorder.apply(authoring()).ok).toBe(true);
    expect(recorder.apply({ kind: 'move', entity: 'player', to: { x: 4, y: 4 } }).ok).toBe(true);
    const finished = engine.hash();
    recorder.close();

    const lines = [...sink.lines];
    // The recording carries the terrain itself. Nothing in it needs regenerating.
    expect(lines.join('\n')).toContain('MapAuthored');
    expect(JSON.parse(lines[2]!).diffs[0].map.cells).toHaveLength(48);

    const report = replay(lines, createEngine);
    expect(report.divergence).toBeUndefined();
    expect(report.ok).toBe(true);
    expect(report.turns).toBe(3);
    expect(report.finalHash).toBe(finished);
  });

  it('the authored map is inside the state hash', () => {
    const engine = engineWithFrontier();
    const before = engine.hash();
    expect(engine.apply(authoring()).ok).toBe(true);
    expect(engine.hash()).not.toBe(before);
  });
});

// -----------------------------------------------------------------------------------------------
// The refusals. Every one of these leaves the world byte-identical.
// -----------------------------------------------------------------------------------------------

describe('the model cannot author a broken world into existence', () => {
  const broken: [string, Partial<AuthorMapIntent>, RegExp][] = [
    [
      'unreachable: the objective sits behind a wall',
      {
        terrain: [...SEALED_ROWS],
        objectives: [{ at: { x: 3, y: 3 }, note: 'the reliquary', quest: null }],
      },
      /objective at \(3, 3\) cannot be walked to from the entrance at \(6, 4\)/,
    ],
    [
      'unreachable: a way out nothing can reach',
      {
        terrain: [...SEALED_ROWS],
        objectives: [],
        frontiers: [{ at: { x: 3, y: 3 }, label: 'a shaft' }],
      },
      /way out at \(3, 3\) cannot be walked to from the entrance/,
    ],
    [
      'disconnected: a walkable pocket with no path from the entrance',
      { terrain: [...SEALED_ROWS], objectives: [] },
      /1 walkable tile of north-road, starting at \(3, 3\), cannot be reached from the entrance/,
    ],
    [
      'malformed: the cell count lies',
      { terrain: ['#######', '#.....#', '#.....#', '#.....#', '#.....#', '#######'] },
      /declares 8 x 6 = 48 cells, but terrain row 0 has 7/,
    ],
    [
      'malformed: the wrong number of rows',
      { terrain: [...OPEN_ROWS.slice(0, 5)] },
      /declares 8 x 6 = 48 cells, but its terrain has 5 rows/,
    ],
    [
      'malformed: a glyph the engine does not know',
      { terrain: ['########', '#..X...#', '#......#', '#......#', '#......#', '########'] },
      /has "X" at \(3, 1\); use # for a wall/,
    ],
    [
      'malformed: bigger than the prompt budget and the state hash can afford',
      { width: 500, height: 500 },
      /width must be a whole number between 4 and 40; 500 is not/,
    ],
    [
      'malformed: a map id that is already loaded',
      { id: FIXTURE_MAP_ID },
      /A location called m0-yard already exists/,
    ],
    [
      'malformed: the entrance is a wall',
      { back: { ...structuredClone(WAY_BACK), at: { x: 0, y: 0 } } },
      /entrance \(0, 0\) is a wall; nobody could stand there/,
    ],
    [
      'dangling: it leads back to a map that does not exist',
      { back: { ...structuredClone(WAY_BACK), to: 'the-old-mill' } },
      /leads back to a map called the-old-mill, and there is no such map/,
    ],
    [
      'dangling: an objective for a quest nobody has',
      { objectives: [{ at: { x: 5, y: 1 }, note: 'the seal', quest: 'second-blood' }] },
      /names a quest called second-blood, and there is no such quest/,
    ],
    [
      'inconsistent: it joins onto the yard where the yard has no way out',
      { back: { ...structuredClone(WAY_BACK), arrive: { x: 5, y: 7 } } },
      /m0-yard has no undefined edge at \(5, 7\) for north-road to be written beyond/,
    ],
    [
      'malformed: a frontier on the tile the way back already uses',
      { frontiers: [{ at: { x: 6, y: 4 }, label: 'a second door in the same stone' }] },
      /two ways out on \(6, 4\)/,
    ],
    [
      'malformed: a tile that is not a pair of whole numbers',
      { back: { ...structuredClone(WAY_BACK), at: { x: NaN, y: NaN } } },
      /entrance is not a tile; write it as \[x, y\]/,
    ],
  ];

  for (const [name, overrides, reason] of broken) {
    it(name, () => {
      const engine = engineWithFrontier();
      const before = engine.hash();
      const verdict = engine.apply(authoring(overrides));
      expect(verdict.ok, `expected a refusal, got ${JSON.stringify(verdict)}`).toBe(false);
      expect(verdict.reason).toMatch(reason);
      expect(verdict.diff).toEqual([]);
      // The refusal left the world untouched: the point of validating before writing.
      expect(engine.hash()).toBe(before);
      expect(Object.keys(engine.snapshot().world.maps)).toEqual([FIXTURE_MAP_ID]);
    });
  }

  it('a second location cannot claim a frontier that has already been written beyond', () => {
    const engine = engineWithFrontier();
    expect(engine.apply(authoring()).ok).toBe(true);
    const before = engine.hash();
    const verdict = engine.apply(authoring({ id: 'south-road' }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/way out at \(10, 1\) already leads somewhere/);
    expect(engine.hash()).toBe(before);
  });

  it('a map with no frontier at all cannot be written beyond', () => {
    // The M0 fixture as it ships: no exits, so nothing to author against. The world only grows
    // at edges that were declared undefined on purpose.
    const engine = createEngine(fixtureSnapshot(), { seed: FIXTURE_SEED });
    const before = engine.hash();
    const verdict = engine.apply(authoring());
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/m0-yard has no undefined edge at \(10, 1\)/);
    expect(engine.hash()).toBe(before);
  });
});
