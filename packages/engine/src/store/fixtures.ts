import {
  PROTOCOL_VERSION,
  type Entity,
  type MapRecord,
  type Seed,
  type Snapshot,
  type TileCell,
} from '@deliberate/protocol';

/**
 * Fixtures shared across packages' tests (server room tests, client dev mode, recorder replay).
 * Everything here is plain data; call the functions to get fresh copies.
 */

export const FIXTURE_MAP_ID = 'm0-yard';
export const FIXTURE_SEED: Seed = 'm0-fixture-seed';

export const FIXTURE_PLAYER_ID = 'player';
export const FIXTURE_DUMMY_IDS = ['dummy-a', 'dummy-b'] as const;

/**
 * 12x12 yard. `#` unwalkable (wall or pillar), `.` floor at elevation 0, digits are walkable
 * cells at that elevation. A raised platform sits east (elevation 1 then 2), a low wall runs
 * across the middle with a gap, and a cliff (elevation 3) blocks the south-west corner.
 *
 * Coordinates: x → east (column), y → south (row). Player starts at (2, 2); dummies at (8, 3)
 * and (6, 9).
 */
export const FIXTURE_MAP_ROWS: readonly string[] = [
  '############',
  '#..........#',
  '#.......112#',
  '#.......112#',
  '#..#....112#',
  '#..#.......#',
  '#####.####.#',
  '#..........#',
  '#33........#',
  '#33....#...#',
  '#33....#...#',
  '############',
];

export function parseMapRows(id: string, rows: readonly string[]): MapRecord {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const cells: TileCell[] = [];
  for (const row of rows) {
    if (row.length !== width) throw new Error(`fixture map row "${row}" is not ${width} wide`);
    for (const ch of row) {
      if (ch === '#') cells.push({ elevation: 0, walkable: false });
      else if (ch === '.') cells.push({ elevation: 0, walkable: true });
      else if (ch >= '0' && ch <= '9') cells.push({ elevation: Number(ch), walkable: true });
      else throw new Error(`fixture map has unknown glyph "${ch}"`);
    }
  }
  return { id, width, height, cells };
}

export function fixtureMap(): MapRecord {
  return parseMapRows(FIXTURE_MAP_ID, FIXTURE_MAP_ROWS);
}

export function fixturePlayer(): Entity {
  return {
    id: FIXTURE_PLAYER_ID,
    name: 'Player',
    components: {
      position: { map: FIXTURE_MAP_ID, x: 2, y: 2, facing: 'E' },
      stats: {
        str: 16,
        dex: 14,
        con: 14,
        int: 10,
        wis: 12,
        cha: 10,
        ac: 16,
        speed: 30,
        proficiency: 2,
      },
      health: { hp: 12, maxHp: 12, conditions: [] },
      inventory: { items: [{ item: 'longsword', qty: 1 }] },
      faction: { id: 'party' },
      disposition: { toward: {} },
      brain: { policy: 'player' },
      dialogue: { seeds: [] },
      portrait: { asset: 'portraits/player.png' },
    },
  };
}

export function fixtureDummy(id: string, name: string, x: number, y: number): Entity {
  return {
    id,
    name,
    components: {
      position: { map: FIXTURE_MAP_ID, x, y, facing: 'W' },
      stats: {
        str: 10,
        dex: 10,
        con: 10,
        int: 3,
        wis: 3,
        cha: 3,
        ac: 10,
        speed: 30,
        proficiency: 0,
      },
      health: { hp: 10, maxHp: 10, conditions: [] },
      inventory: { items: [] },
      faction: { id: 'dummies' },
      disposition: { toward: {} },
      brain: { policy: 'none' },
      dialogue: { seeds: ['...'] },
      portrait: { asset: 'portraits/dummy.png' },
    },
  };
}

/** A player and two training dummies on the fixture map. Fresh object on every call. */
export function fixtureSnapshot(): Snapshot {
  const map = fixtureMap();
  const player = fixturePlayer();
  const a = fixtureDummy(FIXTURE_DUMMY_IDS[0], 'Training Dummy A', 8, 3);
  const b = fixtureDummy(FIXTURE_DUMMY_IDS[1], 'Training Dummy B', 6, 9);
  return {
    schema: PROTOCOL_VERSION,
    entities: { [player.id]: player, [a.id]: a, [b.id]: b },
    world: {
      flags: { tutorial: true },
      quests: {
        'first-blood': {
          id: 'first-blood',
          title: 'First blood',
          steps: ['Walk to a dummy', 'Hit it'],
          step: 0,
        },
      },
      clock: 0,
      maps: { [map.id]: map },
    },
    initiative: null,
  };
}
