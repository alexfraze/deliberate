import type { MapRecord, Tile } from '@deliberate/protocol';

import { cellAt, inBounds, tileEquals } from './tile.js';

/**
 * Every tile a straight segment from the centre of `a` to the centre of `b` passes through
 * (a "supercover" line), in order, excluding `a` and `b`. Where the segment crosses a corner
 * exactly, both tiles that share the corner are included, so a diagonal cannot slip between
 * two blockers.
 */
export function tilesBetween(a: Tile, b: Tile): Tile[] {
  const out: Tile[] = [];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const nx = Math.abs(dx);
  const ny = Math.abs(dy);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  let x = a.x;
  let y = a.y;
  let ix = 0;
  let iy = 0;
  // Compare (ix + 0.5) / nx against (iy + 0.5) / ny in integers to avoid float drift.
  while (ix < nx || iy < ny) {
    const cx = (2 * ix + 1) * ny;
    const cy = (2 * iy + 1) * nx;
    if (cx === cy) {
      // Exact corner: include both side tiles, then step diagonally.
      out.push({ x: x + sx, y }, { x, y: y + sy });
      x += sx;
      y += sy;
      ix++;
      iy++;
    } else if (cx < cy) {
      x += sx;
      ix++;
    } else {
      y += sy;
      iy++;
    }
    if (!(x === b.x && y === b.y)) out.push({ x, y });
  }
  // Remove duplicates that the corner case can create when the next step lands on a side tile.
  const seen = new Set<string>();
  return out.filter((t) => {
    if (tileEquals(t, a) || tileEquals(t, b)) return false;
    const k = `${t.x},${t.y}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface LineOfSightOptions {
  /**
   * Extra tiles that block sight (other creatures, doors) beyond the map's own cells. Keys are
   * `tileKey()` strings. Default: none.
   */
  blockers?: ReadonlySet<string>;
}

/**
 * Line of sight over the map: true when no intermediate cell blocks the segment from `a` to `b`.
 *
 * A cell blocks when it is out of bounds, not walkable (M0 treats every unwalkable cell as a
 * solid wall or pillar), or its elevation is strictly higher than both endpoints (a ledge you
 * cannot see over). Adjacent tiles and a tile to itself always have line of sight, provided both
 * are on the map.
 */
export function lineOfSight(
  map: MapRecord,
  a: Tile,
  b: Tile,
  opts: LineOfSightOptions = {},
): boolean {
  if (!inBounds(map, a) || !inBounds(map, b)) return false;
  const ea = cellAt(map, a)?.elevation ?? 0;
  const eb = cellAt(map, b)?.elevation ?? 0;
  const eyeLine = Math.max(ea, eb);
  for (const t of tilesBetween(a, b)) {
    const cell = cellAt(map, t);
    if (!cell || !cell.walkable) return false;
    if (cell.elevation > eyeLine) return false;
    if (opts.blockers?.has(`${t.x},${t.y}`)) return false;
  }
  return true;
}
