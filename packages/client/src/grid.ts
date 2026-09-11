/**
 * Grid math for the renderer: tile coordinates <-> world coordinates, plus the framing numbers
 * the isometric camera needs. Pure — no three.js — so it is unit-testable under node.
 *
 * World axes match three.js: x -> east (tile.x), z -> south (tile.y), y -> up (elevation).
 * The map is centred on the origin so the camera can always look at (0, 0, 0).
 */
import type { MapRecord, Tile, TileCell } from '@deliberate/protocol';

/** Width of one tile in world units. Everything else is expressed in tiles. */
export const TILE_SIZE = 1;

/** World units per integer step of `TileCell.elevation`. */
export const ELEVATION_STEP = 0.35;

/** How thick the slab under an elevation-0 tile is drawn. */
export const TILE_THICKNESS = 0.25;

export interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

export function inBounds(map: MapRecord, tile: Tile): boolean {
  return (
    Number.isInteger(tile.x) &&
    Number.isInteger(tile.y) &&
    tile.x >= 0 &&
    tile.y >= 0 &&
    tile.x < map.width &&
    tile.y < map.height
  );
}

/** Row-major lookup. Returns undefined outside the map. */
export function cellAt(map: MapRecord, tile: Tile): TileCell | undefined {
  if (!inBounds(map, tile)) return undefined;
  return map.cells[tile.y * map.width + tile.x];
}

export function isWalkable(map: MapRecord, tile: Tile): boolean {
  return cellAt(map, tile)?.walkable ?? false;
}

export function elevationAt(map: MapRecord, tile: Tile): number {
  return cellAt(map, tile)?.elevation ?? 0;
}

/** Height of the walkable surface of a tile, in world units. */
export function surfaceY(map: MapRecord, tile: Tile): number {
  return elevationAt(map, tile) * ELEVATION_STEP;
}

/**
 * Centre of the top face of a tile. Accepts fractional tile coordinates so a tween along a path
 * can ask for the point between two tiles; elevation is interpolated from the tiles it sits
 * between.
 */
export function tileToWorld(map: MapRecord, x: number, y: number): WorldPoint {
  return {
    x: (x - (map.width - 1) / 2) * TILE_SIZE,
    y: interpolatedSurfaceY(map, x, y),
    z: (y - (map.height - 1) / 2) * TILE_SIZE,
  };
}

function interpolatedSurfaceY(map: MapRecord, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const a = surfaceY(map, { x: x0, y: y0 });
  const b = surfaceY(map, { x: x0 + (fx > 0 ? 1 : 0), y: y0 });
  const c = surfaceY(map, { x: x0, y: y0 + (fy > 0 ? 1 : 0) });
  const d = surfaceY(map, { x: x0 + (fx > 0 ? 1 : 0), y: y0 + (fy > 0 ? 1 : 0) });
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** Inverse of `tileToWorld` on the x/z plane. Returns null when the point is off the map. */
export function worldToTile(map: MapRecord, x: number, z: number): Tile | null {
  const tile = {
    x: Math.round(x / TILE_SIZE + (map.width - 1) / 2),
    y: Math.round(z / TILE_SIZE + (map.height - 1) / 2),
  };
  return inBounds(map, tile) ? tile : null;
}

export interface CameraFrame {
  /** Where the camera sits, looking at the origin. */
  position: WorldPoint;
  target: WorldPoint;
  /** Half-extents for an orthographic frustum that fits the whole map at this aspect ratio. */
  halfWidth: number;
  halfHeight: number;
  near: number;
  far: number;
}

/** Classic 3/4 isometric direction: equal parts east, up, and south-ish. */
const ISO_DIRECTION: WorldPoint = { x: 1, y: 1, z: 1 };

/**
 * An orthographic frame that fits the whole map with a margin. `zoom` > 1 moves in closer.
 * Bounds are derived from the map so a bigger map does not need new constants.
 */
export function isoCameraFrame(map: MapRecord, aspect: number, zoom = 1): CameraFrame {
  const span = Math.max(map.width, map.height) * TILE_SIZE;
  const radius = (span * Math.SQRT2) / 2 + 2;
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const half = radius / Math.max(zoom, 0.1);
  const halfHeight = safeAspect >= 1 ? half : half / safeAspect;
  const halfWidth = halfHeight * safeAspect;
  const distance = span * 2 + 10;
  const length = Math.hypot(ISO_DIRECTION.x, ISO_DIRECTION.y, ISO_DIRECTION.z);
  return {
    position: {
      x: (ISO_DIRECTION.x / length) * distance,
      y: (ISO_DIRECTION.y / length) * distance,
      z: (ISO_DIRECTION.z / length) * distance,
    },
    target: { x: 0, y: 0, z: 0 },
    halfWidth,
    halfHeight,
    near: 0.1,
    far: distance * 4,
  };
}

/** Chebyshev distance in tiles; 8-way movement makes a diagonal cost the same as a step. */
export function tileDistance(a: Tile, b: Tile): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function sameTile(a: Tile | null, b: Tile | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y;
}
