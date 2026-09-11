import type { MapRecord, Tile } from '@deliberate/protocol';

import {
  cellAt,
  DIRECTIONS,
  DIRECTION_DELTAS,
  inBounds,
  isWalkable,
  tileEquals,
  tileKey,
} from './tile.js';

/** Largest elevation change a single step may cross. Two or more is a climb, not a walk. */
export const MAX_STEP_ELEVATION = 1;

export interface PathOptions {
  /** Tiles that cannot be entered or passed through (occupied by creatures). `tileKey()` strings. */
  blocked?: ReadonlySet<string>;
  /** Maximum elevation delta per step. Default MAX_STEP_ELEVATION. */
  maxStepElevation?: number;
}

/**
 * A step from `from` to its neighbour `to` is legal when `to` is on the map, walkable, not
 * blocked, and the elevation change is within `maxStepElevation`. Diagonal steps additionally
 * require both orthogonal corners to be passable so a path cannot cut through a wall corner.
 */
export function canStep(map: MapRecord, from: Tile, to: Tile, opts: PathOptions = {}): boolean {
  if (!inBounds(map, from) || !inBounds(map, to)) return false;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) return false;
  const fromCell = cellAt(map, from);
  const toCell = cellAt(map, to);
  if (!fromCell || !toCell || !toCell.walkable) return false;
  if (opts.blocked?.has(tileKey(to))) return false;
  const maxStep = opts.maxStepElevation ?? MAX_STEP_ELEVATION;
  if (Math.abs(toCell.elevation - fromCell.elevation) > maxStep) return false;
  if (dx !== 0 && dy !== 0) {
    // No corner cutting past unwalkable cells (creatures do not block corners).
    if (!isWalkable(map, { x: from.x + dx, y: from.y })) return false;
    if (!isWalkable(map, { x: from.x, y: from.y + dy })) return false;
  }
  return true;
}

/**
 * Shortest 8-way path from `a` to `b` costing at most `maxCost` tiles (each step, diagonal or
 * not, costs 1). Returns the tiles stepped through, excluding `a` and including `b`, or `null`
 * when `b` is unreachable within budget. A path to the start tile is the empty array.
 *
 * Breadth-first search with a fixed neighbour order (clockwise from north), so the same inputs
 * always return the same path; that matters because the path is recorded in `EntityMoved`.
 */
export function path(
  map: MapRecord,
  a: Tile,
  b: Tile,
  maxCost: number,
  opts: PathOptions = {},
): Tile[] | null {
  if (!inBounds(map, a) || !inBounds(map, b)) return null;
  if (tileEquals(a, b)) return [];
  if (maxCost < 1 || !isWalkable(map, b) || opts.blocked?.has(tileKey(b))) return null;

  const cameFrom = new Map<string, Tile | null>();
  cameFrom.set(tileKey(a), null);
  let frontier: Tile[] = [a];
  for (let cost = 1; cost <= maxCost && frontier.length > 0; cost++) {
    const next: Tile[] = [];
    for (const cur of frontier) {
      for (const dir of DIRECTIONS) {
        const d = DIRECTION_DELTAS[dir];
        const n = { x: cur.x + d.x, y: cur.y + d.y };
        const k = tileKey(n);
        if (cameFrom.has(k) || !canStep(map, cur, n, opts)) continue;
        cameFrom.set(k, cur);
        if (tileEquals(n, b)) return unwind(cameFrom, n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return null;
}

/** Every tile reachable from `a` within `maxCost` steps, with its cost, excluding `a`. */
export function reachable(
  map: MapRecord,
  a: Tile,
  maxCost: number,
  opts: PathOptions = {},
): Map<string, { tile: Tile; cost: number }> {
  const out = new Map<string, { tile: Tile; cost: number }>();
  if (!inBounds(map, a)) return out;
  const seen = new Set<string>([tileKey(a)]);
  let frontier: Tile[] = [a];
  for (let cost = 1; cost <= maxCost && frontier.length > 0; cost++) {
    const next: Tile[] = [];
    for (const cur of frontier) {
      for (const dir of DIRECTIONS) {
        const d = DIRECTION_DELTAS[dir];
        const n = { x: cur.x + d.x, y: cur.y + d.y };
        const k = tileKey(n);
        if (seen.has(k) || !canStep(map, cur, n, opts)) continue;
        seen.add(k);
        out.set(k, { tile: n, cost });
        next.push(n);
      }
    }
    frontier = next;
  }
  return out;
}

function unwind(cameFrom: Map<string, Tile | null>, end: Tile): Tile[] {
  const out: Tile[] = [];
  let cur: Tile | null = end;
  while (cur) {
    const prev: Tile | null | undefined = cameFrom.get(tileKey(cur));
    if (prev === undefined) break;
    if (prev !== null) out.push(cur);
    cur = prev;
  }
  return out.reverse();
}
