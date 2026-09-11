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

/** Unwalkable cells are drawn this much proud of their elevation so they read as walls. */
export const WALL_HEIGHT = 0.5;

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
 * Height of the *drawn* top of a tile. Same as `surfaceY` for floor; unwalkable cells stand proud
 * so a wall looks like a wall rather than a dark hole. Entities stand on `surfaceY`.
 */
export function visualTopY(map: MapRecord, tile: Tile): number {
  const cell = cellAt(map, tile);
  if (!cell) return 0;
  return cell.elevation * ELEVATION_STEP + (cell.walkable ? 0 : WALL_HEIGHT);
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

/** Classic 3/4 isometric direction: equal parts east, up, and south. */
const ISO_DIRECTION: WorldPoint = { x: 1, y: 1, z: 1 };

/** Margin, in tiles, kept between the map and the edge of the frustum. */
const CAMERA_MARGIN = 1;

function normalise(v: WorldPoint): WorldPoint {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function cross(a: WorldPoint, b: WorldPoint): WorldPoint {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: WorldPoint, b: WorldPoint): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Half-extents of the map as the isometric camera sees it, in its own screen plane. A square map
 * projects to a diamond, so fitting its bounding circle would waste most of the viewport
 * vertically; this measures the corners through the camera basis instead.
 */
export function projectedHalfExtents(map: MapRecord): { u: number; v: number } {
  const direction = normalise(ISO_DIRECTION);
  const right = normalise(cross(direction, { x: 0, y: 1, z: 0 }));
  const up = cross(right, direction);
  const halfW = (map.width / 2) * TILE_SIZE;
  const halfH = (map.height / 2) * TILE_SIZE;
  let topY = 0;
  for (const cell of map.cells) topY = Math.max(topY, cell.elevation * ELEVATION_STEP);
  let u = 0;
  let v = 0;
  for (const x of [-halfW, halfW]) {
    for (const z of [-halfH, halfH]) {
      for (const y of [-TILE_THICKNESS, topY]) {
        const corner = { x, y, z };
        u = Math.max(u, Math.abs(dot(corner, right)));
        v = Math.max(v, Math.abs(dot(corner, up)));
      }
    }
  }
  return { u: u + CAMERA_MARGIN, v: v + CAMERA_MARGIN };
}

/**
 * An orthographic frame that fits the whole map at this aspect ratio. `zoom` > 1 moves in closer.
 * Everything is derived from the map, so a bigger map needs no new constants.
 */
export function isoCameraFrame(map: MapRecord, aspect: number, zoom = 1): CameraFrame {
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const extents = projectedHalfExtents(map);
  const halfWidth = Math.max(extents.u, extents.v * safeAspect) / Math.max(zoom, 0.1);
  const span = Math.max(map.width, map.height) * TILE_SIZE;
  const distance = span * 2 + 10;
  const direction = normalise(ISO_DIRECTION);
  return {
    position: {
      x: direction.x * distance,
      y: direction.y * distance,
      z: direction.z * distance,
    },
    target: { x: 0, y: 0, z: 0 },
    halfWidth,
    halfHeight: halfWidth / safeAspect,
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
