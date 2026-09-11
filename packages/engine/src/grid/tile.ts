import {
  TILE_FEET,
  type Direction8,
  type MapRecord,
  type Tile,
  type TileCell,
} from '@deliberate/protocol';

/**
 * Tile primitives shared by line of sight and pathing. One tile is 5 ft (TILE_FEET); the grid is
 * square with 8-way movement, so distance is Chebyshev: a diagonal step costs the same as an
 * orthogonal one (SRD 5.1 "Playing on a Grid" variant used by the MVP).
 */

/** Stable string key for maps and sets keyed by tile. */
export function tileKey(t: Tile): string {
  return `${t.x},${t.y}`;
}

export function tileEquals(a: Tile, b: Tile): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Chebyshev distance in tiles. */
export function distanceTiles(a: Tile, b: Tile): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Chebyshev distance in feet (tiles * 5). */
export function distanceFeet(a: Tile, b: Tile): number {
  return distanceTiles(a, b) * TILE_FEET;
}

export function feetToTiles(feet: number): number {
  return Math.floor(feet / TILE_FEET);
}

/** Clockwise from north so iteration order is deterministic everywhere it matters. */
export const DIRECTIONS: readonly Direction8[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export const DIRECTION_DELTAS: Readonly<Record<Direction8, Tile>> = {
  N: { x: 0, y: -1 },
  NE: { x: 1, y: -1 },
  E: { x: 1, y: 0 },
  SE: { x: 1, y: 1 },
  S: { x: 0, y: 1 },
  SW: { x: -1, y: 1 },
  W: { x: -1, y: 0 },
  NW: { x: -1, y: -1 },
};

/** Direction from `from` toward `to`, or null when they are the same tile. */
export function directionTo(from: Tile, to: Tile): Direction8 | null {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  if (dx === 0 && dy === 0) return null;
  for (const dir of DIRECTIONS) {
    const d = DIRECTION_DELTAS[dir];
    if (d.x === dx && d.y === dy) return dir;
  }
  return null;
}

export function inBounds(map: Pick<MapRecord, 'width' | 'height'>, t: Tile): boolean {
  return (
    Number.isInteger(t.x) &&
    Number.isInteger(t.y) &&
    t.x >= 0 &&
    t.y >= 0 &&
    t.x < map.width &&
    t.y < map.height
  );
}

/** The cell at `t`, or undefined when out of bounds. `cells` is row-major. */
export function cellAt(map: MapRecord, t: Tile): TileCell | undefined {
  if (!inBounds(map, t)) return undefined;
  return map.cells[t.y * map.width + t.x];
}

export function isWalkable(map: MapRecord, t: Tile): boolean {
  return cellAt(map, t)?.walkable ?? false;
}

/** All in-bounds 8-way neighbours of `t`, clockwise from north. Ignores walkability. */
export function neighbours8(map: Pick<MapRecord, 'width' | 'height'>, t: Tile): Tile[] {
  const out: Tile[] = [];
  for (const dir of DIRECTIONS) {
    const d = DIRECTION_DELTAS[dir];
    const n = { x: t.x + d.x, y: t.y + d.y };
    if (inBounds(map, n)) out.push(n);
  }
  return out;
}
