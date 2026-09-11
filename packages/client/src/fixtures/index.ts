/**
 * Dev fixtures so the renderer runs with no server: `?fixture=1`.
 *
 * The shapes come from `@deliberate/protocol`; the data mirrors the engine's M0 yard fixture but
 * is duplicated here on purpose — the client must not depend on `@deliberate/engine`. If the
 * engine's fixture map changes, this one only has to stay *plausible*, not identical: nothing
 * asserts they match.
 */
import {
  DEFAULT_ROOM,
  PROTOCOL_VERSION,
  type Diff,
  type Entity,
  type MapRecord,
  type ServerMessage,
  type Snapshot,
  type TileCell,
} from '@deliberate/protocol';

export const FIXTURE_MAP_ID = 'm0-yard';
export const FIXTURE_PLAYER_ID = 'player';

/** `#` unwalkable, `.` floor at elevation 0, a digit is a walkable cell at that elevation. */
const FIXTURE_MAP_ROWS: readonly string[] = [
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

function actor(
  id: string,
  name: string,
  faction: string,
  x: number,
  y: number,
  hp: number,
): Entity {
  return {
    id,
    name,
    components: {
      position: { map: FIXTURE_MAP_ID, x, y, facing: 'E' },
      stats: {
        str: 14,
        dex: 12,
        con: 12,
        int: 10,
        wis: 10,
        cha: 10,
        ac: 13,
        speed: 30,
        proficiency: 2,
      },
      health: { hp, maxHp: hp, conditions: [] },
      inventory: { items: [{ item: 'longsword', qty: 1 }] },
      faction: { id: faction },
      disposition: { toward: {} },
      brain: { policy: id === FIXTURE_PLAYER_ID ? 'player' : 'none' },
      dialogue: { seeds: [] },
      portrait: { asset: `portraits/${id}.png` },
    },
  };
}

/** A player and two training dummies on the yard. Fresh objects on every call. */
export function fixtureSnapshot(): Snapshot {
  const map = fixtureMap();
  const entities = [
    actor(FIXTURE_PLAYER_ID, 'Player', 'party', 2, 2, 12),
    actor('dummy-a', 'Training Dummy A', 'dummies', 8, 3, 10),
    actor('dummy-b', 'Training Dummy B', 'dummies', 6, 9, 10),
  ];
  return {
    schema: PROTOCOL_VERSION,
    entities: Object.fromEntries(entities.map((e) => [e.id, e])),
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

export function fixtureSnapshotMessage(turn = 0): ServerMessage {
  return {
    type: 'snapshot',
    room: DEFAULT_ROOM,
    turn,
    snapshot: fixtureSnapshot(),
    hash: 'fixture-hash-0',
  };
}

/**
 * A scripted turn: the player walks to the east dummy and hits it, the dummy hits back. Played on
 * a timer at start-up so the animation queue is exercised without touching anything.
 */
export function fixtureScript(): Diff[][] {
  return [
    [
      {
        type: 'EntityMoved',
        entity: FIXTURE_PLAYER_ID,
        from: { x: 2, y: 2 },
        to: { x: 7, y: 3 },
        path: [
          { x: 3, y: 2 },
          { x: 4, y: 2 },
          { x: 5, y: 3 },
          { x: 6, y: 3 },
          { x: 7, y: 3 },
        ],
      },
    ],
    [
      {
        type: 'DamageApplied',
        target: 'dummy-a',
        amount: 6,
        source: FIXTURE_PLAYER_ID,
        hpAfter: 4,
      },
      { type: 'DialogueLine', speaker: 'dummy-a', text: 'thud', to: FIXTURE_PLAYER_ID },
    ],
    [
      {
        type: 'DamageApplied',
        target: FIXTURE_PLAYER_ID,
        amount: 3,
        source: 'dummy-a',
        hpAfter: 9,
      },
      { type: 'FlagSet', key: 'tutorial', value: false },
    ],
  ];
}
