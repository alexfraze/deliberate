import { describe, expect, it } from 'vitest';

import { fixtureMap, parseMapRows } from './fixtures/index.js';
import {
  ELEVATION_STEP,
  cellAt,
  elevationAt,
  inBounds,
  isWalkable,
  isoCameraFrame,
  projectedHalfExtents,
  sameTile,
  tileDistance,
  visualTopY,
  tileToWorld,
  worldToTile,
} from './grid.js';

const map = fixtureMap();

describe('cell lookup', () => {
  it('reads the row-major grid', () => {
    expect(map.width).toBe(12);
    expect(map.height).toBe(12);
    expect(isWalkable(map, { x: 0, y: 0 })).toBe(false);
    expect(isWalkable(map, { x: 2, y: 2 })).toBe(true);
    expect(elevationAt(map, { x: 10, y: 2 })).toBe(2);
    expect(cellAt(map, { x: 9, y: 2 })).toEqual({ elevation: 1, walkable: true });
  });

  it('treats anything off the map as missing, not as tile 0', () => {
    expect(inBounds(map, { x: -1, y: 0 })).toBe(false);
    expect(inBounds(map, { x: 0, y: 12 })).toBe(false);
    expect(inBounds(map, { x: 1.5, y: 0 })).toBe(false);
    expect(cellAt(map, { x: -1, y: 0 })).toBeUndefined();
    expect(isWalkable(map, { x: 99, y: 99 })).toBe(false);
  });
});

describe('visualTopY', () => {
  it('stands unwalkable cells proud so they read as walls', () => {
    expect(visualTopY(map, { x: 2, y: 2 })).toBeCloseTo(0);
    expect(visualTopY(map, { x: 0, y: 0 })).toBeGreaterThan(0);
    expect(visualTopY(map, { x: 10, y: 2 })).toBeCloseTo(2 * ELEVATION_STEP);
    expect(visualTopY(map, { x: -1, y: -1 })).toBe(0);
  });
});

describe('tile <-> world', () => {
  it('centres the map on the origin', () => {
    const nw = tileToWorld(map, 0, 0);
    const se = tileToWorld(map, map.width - 1, map.height - 1);
    expect(nw.x).toBeCloseTo(-5.5);
    expect(nw.z).toBeCloseTo(-5.5);
    expect(se.x).toBeCloseTo(5.5);
    expect(se.z).toBeCloseTo(5.5);
  });

  it('lifts a tile by its elevation', () => {
    expect(tileToWorld(map, 2, 2).y).toBeCloseTo(0);
    expect(tileToWorld(map, 10, 2).y).toBeCloseTo(2 * ELEVATION_STEP);
  });

  it('interpolates elevation between tiles so a tween walks up a step', () => {
    const mid = tileToWorld(map, 7.5, 2);
    expect(mid.y).toBeCloseTo(0.5 * ELEVATION_STEP);
  });

  it('round-trips every tile through world space', () => {
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const world = tileToWorld(map, x, y);
        expect(worldToTile(map, world.x, world.z)).toEqual({ x, y });
      }
    }
  });

  it('returns null for world points outside the map', () => {
    expect(worldToTile(map, 100, 0)).toBeNull();
    expect(worldToTile(map, 0, -100)).toBeNull();
  });
});

describe('isoCameraFrame', () => {
  it('fits the whole map at any aspect ratio', () => {
    const extents = projectedHalfExtents(map);
    for (const aspect of [0.5, 1, 1.286, 2, 3]) {
      const frame = isoCameraFrame(map, aspect);
      expect(frame.halfWidth).toBeGreaterThanOrEqual(extents.u - 1e-9);
      expect(frame.halfHeight).toBeGreaterThanOrEqual(extents.v - 1e-9);
      expect(frame.halfWidth / frame.halfHeight).toBeCloseTo(aspect);
    }
  });

  it('does not waste the viewport on the diamond a square map projects to', () => {
    const extents = projectedHalfExtents(map);
    // The map's bounding circle would be the lazy fit; the real projection is much shorter.
    expect(extents.v).toBeLessThan(extents.u);
  });

  it('looks at the origin from above, equally from east and south', () => {
    const frame = isoCameraFrame(map, 1);
    expect(frame.target).toEqual({ x: 0, y: 0, z: 0 });
    expect(frame.position.y).toBeGreaterThan(0);
    expect(frame.position.x).toBeCloseTo(frame.position.z);
    expect(frame.far).toBeGreaterThan(frame.position.y);
  });

  it('zooms in without changing the aspect ratio', () => {
    const out = isoCameraFrame(map, 1.5, 1);
    const inn = isoCameraFrame(map, 1.5, 2);
    expect(inn.halfWidth).toBeLessThan(out.halfWidth);
    expect(inn.halfWidth / inn.halfHeight).toBeCloseTo(out.halfWidth / out.halfHeight);
  });

  it('survives a degenerate aspect ratio (a zero-height canvas at start-up)', () => {
    const frame = isoCameraFrame(map, 0);
    expect(Number.isFinite(frame.halfWidth)).toBe(true);
    expect(Number.isFinite(frame.halfHeight)).toBe(true);
  });

  it('grows the frame for a taller map', () => {
    const tall = parseMapRows(
      'tall',
      Array.from({ length: 24 }, () => '.'.repeat(24)),
    );
    expect(projectedHalfExtents(tall).u).toBeGreaterThan(projectedHalfExtents(map).u);
  });
});

describe('tile helpers', () => {
  it('measures 8-way distance', () => {
    expect(tileDistance({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(3);
    expect(tileDistance({ x: 0, y: 0 }, { x: 3, y: 1 })).toBe(3);
    expect(sameTile({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
    expect(sameTile({ x: 1, y: 2 }, null)).toBe(false);
    expect(sameTile(null, null)).toBe(true);
  });
});

describe('parseMapRows', () => {
  it('rejects a ragged map', () => {
    expect(() => parseMapRows('bad', ['..', '...'])).toThrow(/not 2 wide/);
  });

  it('rejects an unknown glyph', () => {
    expect(() => parseMapRows('bad', ['?'])).toThrow(/unknown glyph/);
  });
});
