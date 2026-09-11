import type { MapRecord, Tile, TileCell } from '@deliberate/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { lineOfSight, tilesBetween } from './los.js';
import { canStep, path, reachable } from './path.js';
import {
  cellAt,
  directionTo,
  distanceFeet,
  distanceTiles,
  inBounds,
  neighbours8,
  tileKey,
} from './tile.js';

/**
 * Build a map from ASCII rows: `#` is a wall, a digit is a walkable cell at that elevation,
 * `.` is walkable at elevation 0.
 */
function mapFrom(rows: string[]): MapRecord {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const cells: TileCell[] = [];
  for (const row of rows) {
    for (const ch of row) {
      if (ch === '#') cells.push({ elevation: 0, walkable: false });
      else if (ch === '.') cells.push({ elevation: 0, walkable: true });
      else cells.push({ elevation: Number(ch), walkable: true });
    }
  }
  return { id: 'test', width, height, cells };
}

const open = mapFrom(['.....', '.....', '.....', '.....', '.....']);

describe('tile math', () => {
  it('Chebyshev distance treats diagonals as one tile', () => {
    expect(distanceTiles({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(3);
    expect(distanceTiles({ x: 0, y: 0 }, { x: 3, y: 1 })).toBe(3);
    expect(distanceTiles({ x: 2, y: 2 }, { x: 2, y: 2 })).toBe(0);
    expect(distanceFeet({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(30);
  });

  it('lists 8 in-bounds neighbours clockwise from north, fewer at edges', () => {
    expect(neighbours8(open, { x: 2, y: 2 })).toEqual([
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 3, y: 2 },
      { x: 3, y: 3 },
      { x: 2, y: 3 },
      { x: 1, y: 3 },
      { x: 1, y: 2 },
      { x: 1, y: 1 },
    ]);
    expect(neighbours8(open, { x: 0, y: 0 })).toHaveLength(3);
    expect(neighbours8(open, { x: 4, y: 2 })).toHaveLength(5);
  });

  it('reads row-major cells and rejects out-of-bounds or fractional tiles', () => {
    const m = mapFrom(['.#', '2.']);
    expect(cellAt(m, { x: 1, y: 0 })).toEqual({ elevation: 0, walkable: false });
    expect(cellAt(m, { x: 0, y: 1 })).toEqual({ elevation: 2, walkable: true });
    expect(cellAt(m, { x: 2, y: 0 })).toBeUndefined();
    expect(inBounds(m, { x: 0.5, y: 0 })).toBe(false);
    expect(inBounds(m, { x: -1, y: 0 })).toBe(false);
  });

  it('names the direction toward a tile', () => {
    expect(directionTo({ x: 0, y: 0 }, { x: 5, y: -2 })).toBe('NE');
    expect(directionTo({ x: 0, y: 0 }, { x: 0, y: 3 })).toBe('S');
    expect(directionTo({ x: 1, y: 1 }, { x: 1, y: 1 })).toBeNull();
  });

  it('tileKey is injective on integer tiles', () => {
    fc.assert(
      fc.property(
        fc.record({ x: fc.integer({ min: -50, max: 50 }), y: fc.integer({ min: -50, max: 50 }) }),
        fc.record({ x: fc.integer({ min: -50, max: 50 }), y: fc.integer({ min: -50, max: 50 }) }),
        (a: Tile, b: Tile) => {
          expect(tileKey(a) === tileKey(b)).toBe(a.x === b.x && a.y === b.y);
        },
      ),
      { seed: 8 },
    );
  });
});

describe('line of sight', () => {
  it('always sees adjacent tiles and itself', () => {
    expect(lineOfSight(open, { x: 1, y: 1 }, { x: 1, y: 1 })).toBe(true);
    expect(lineOfSight(open, { x: 1, y: 1 }, { x: 2, y: 2 })).toBe(true);
  });

  it('is blocked by a wall on the segment and symmetric', () => {
    const m = mapFrom(['.....', '.....', '..#..', '.....', '.....']);
    expect(lineOfSight(m, { x: 0, y: 2 }, { x: 4, y: 2 })).toBe(false);
    expect(lineOfSight(m, { x: 4, y: 2 }, { x: 0, y: 2 })).toBe(false);
    expect(lineOfSight(m, { x: 0, y: 0 }, { x: 4, y: 4 })).toBe(false);
    expect(lineOfSight(m, { x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
    expect(lineOfSight(m, { x: 0, y: 1 }, { x: 4, y: 3 })).toBe(false);
  });

  it('does not slip diagonally between two walls that share a corner', () => {
    const m = mapFrom(['.#.', '#..', '...']);
    expect(lineOfSight(m, { x: 0, y: 0 }, { x: 2, y: 2 })).toBe(false);
  });

  it('a ledge higher than both ends blocks; standing on it does not', () => {
    const m = mapFrom(['.....', '.....', '22222', '.....', '.....']);
    expect(lineOfSight(m, { x: 2, y: 0 }, { x: 2, y: 4 })).toBe(false);
    expect(lineOfSight(m, { x: 2, y: 2 }, { x: 2, y: 4 })).toBe(true);
    expect(lineOfSight(m, { x: 2, y: 0 }, { x: 2, y: 2 })).toBe(true);
    const low = mapFrom(['.....', '.....', '11111', '.....', '22222']);
    // Endpoint at elevation 2 sees over a ridge of 1.
    expect(lineOfSight(low, { x: 2, y: 4 }, { x: 2, y: 0 })).toBe(true);
  });

  it('extra blockers (creatures) cut sight, endpoints out of bounds never see', () => {
    expect(lineOfSight(open, { x: 0, y: 0 }, { x: 4, y: 0 }, { blockers: new Set(['2,0']) })).toBe(
      false,
    );
    expect(lineOfSight(open, { x: 0, y: 0 }, { x: 9, y: 0 })).toBe(false);
  });

  it('tilesBetween is symmetric as a set and never includes the endpoints', () => {
    const tile = fc.record({
      x: fc.integer({ min: 0, max: 15 }),
      y: fc.integer({ min: 0, max: 15 }),
    });
    fc.assert(
      fc.property(tile, tile, (a: Tile, b: Tile) => {
        const ab = tilesBetween(a, b).map(tileKey).sort();
        const ba = tilesBetween(b, a).map(tileKey).sort();
        expect(ab).toEqual(ba);
        expect(ab).not.toContain(tileKey(a));
        expect(ab).not.toContain(tileKey(b));
        expect(new Set(ab).size).toBe(ab.length);
      }),
      { seed: 8 },
    );
  });
});

describe('path', () => {
  it('is empty to the start tile and null when out of budget', () => {
    expect(path(open, { x: 0, y: 0 }, { x: 0, y: 0 }, 6)).toEqual([]);
    expect(path(open, { x: 0, y: 0 }, { x: 4, y: 4 }, 3)).toBeNull();
    expect(path(open, { x: 0, y: 0 }, { x: 4, y: 4 }, 4)).toHaveLength(4);
  });

  it('moves diagonally at cost 1 per step and ends on the target', () => {
    const p = path(open, { x: 0, y: 0 }, { x: 4, y: 2 }, 6);
    expect(p).not.toBeNull();
    expect(p).toHaveLength(4);
    expect(p?.at(-1)).toEqual({ x: 4, y: 2 });
    for (let i = 0; i < p!.length; i++) {
      const prev = i === 0 ? { x: 0, y: 0 } : p![i - 1]!;
      expect(distanceTiles(prev, p![i]!)).toBe(1);
    }
  });

  it('routes around walls, refuses to cut corners, and returns null when walled off', () => {
    const m = mapFrom(['.#...', '.#...', '.#.#.', '...#.', '...#.']);
    const p = path(m, { x: 0, y: 0 }, { x: 4, y: 0 }, 20)!;
    expect(p.at(-1)).toEqual({ x: 4, y: 0 });
    for (const t of p) expect(m.cells[t.y * m.width + t.x]?.walkable).toBe(true);
    const corner = mapFrom(['.#', '#.']);
    expect(canStep(corner, { x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false);
    expect(path(corner, { x: 0, y: 0 }, { x: 1, y: 1 }, 5)).toBeNull();
    const walled = mapFrom(['..#..', '..#..', '..#..']);
    expect(path(walled, { x: 0, y: 1 }, { x: 4, y: 1 }, 50)).toBeNull();
  });

  it('cannot climb more than one elevation step at a time', () => {
    const cliff = mapFrom(['.2.']);
    expect(path(cliff, { x: 0, y: 0 }, { x: 2, y: 0 }, 5)).toBeNull();
    const ramp = mapFrom(['.12']);
    expect(path(ramp, { x: 0, y: 0 }, { x: 2, y: 0 }, 5)).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ]);
  });

  it('treats blocked tiles as impassable but not as corner blockers', () => {
    const blocked = new Set(['1,0']);
    expect(path(open, { x: 0, y: 0 }, { x: 1, y: 0 }, 5, { blocked })).toBeNull();
    const around = path(open, { x: 0, y: 0 }, { x: 2, y: 0 }, 5, { blocked })!;
    expect(around).toHaveLength(2);
    expect(around.map(tileKey)).not.toContain('1,0');
  });

  it('is deterministic and never longer than the Chebyshev lower bound on an open map', () => {
    const tile = fc.record({
      x: fc.integer({ min: 0, max: 4 }),
      y: fc.integer({ min: 0, max: 4 }),
    });
    fc.assert(
      fc.property(tile, tile, (a: Tile, b: Tile) => {
        const p1 = path(open, a, b, 10);
        const p2 = path(open, a, b, 10);
        expect(p1).toEqual(p2);
        expect(p1).toHaveLength(distanceTiles(a, b));
      }),
      { seed: 8 },
    );
  });

  it('reachable agrees with path on cost', () => {
    const m = mapFrom(['.#...', '.#.#.', '...#.']);
    const reach = reachable(m, { x: 0, y: 0 }, 4);
    for (const { tile, cost } of reach.values()) {
      expect(path(m, { x: 0, y: 0 }, tile, 4)).toHaveLength(cost);
    }
    expect(reach.has('4,0')).toBe(false);
    expect(path(m, { x: 0, y: 0 }, { x: 4, y: 0 }, 4)).toBeNull();
  });
});
