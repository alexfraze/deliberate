/**
 * The three.js scene: an isometric orthographic camera over the map, one box per `TileCell`,
 * a capsule per entity coloured by faction, a hover highlight, and a selection ring.
 *
 * Everything here is presentation. It reads a `ViewState` (itself derived from snapshot + diffs)
 * and never decides anything about the game; picking returns what was under the cursor and leaves
 * the rules to `selection.ts`.
 */
import type { EntityId, MapRecord, Tile } from '@deliberate/protocol';
import {
  AmbientLight,
  BoxGeometry,
  CapsuleGeometry,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  Raycaster,
  RingGeometry,
  Scene,
  type Vector2,
  Vector3,
} from 'three/webgpu';

import { TILE_SIZE, TILE_THICKNESS, isoCameraFrame, tileToWorld, visualTopY } from './grid.js';
import type { Pick } from './selection.js';
import { isAlive, type ViewState } from './view.js';

const CAPSULE_RADIUS = 0.26;
const CAPSULE_LENGTH = 0.5;
const CAPSULE_HALF = CAPSULE_RADIUS + CAPSULE_LENGTH / 2;

const FACTION_COLORS: Readonly<Record<string, number>> = {
  party: 0x4da3ff,
  dummies: 0xd98c4a,
  vermin: 0x8f9e5c,
};

/** Deterministic hue for a faction the palette does not know about. */
function factionColor(faction: string): Color {
  const known = FACTION_COLORS[faction];
  if (known !== undefined) return new Color(known);
  let hash = 0;
  for (const ch of faction) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return new Color().setHSL(hash / 360, 0.5, 0.6);
}

function tileColor(walkable: boolean, elevation: number): Color {
  if (!walkable) return new Color(0x171c22);
  return new Color(0x39454f).lerp(new Color(0x6f8496), Math.min(1, elevation / 3));
}

export interface GameScene {
  readonly scene: Scene;
  readonly camera: OrthographicCamera;
  setMap(map: MapRecord): void;
  /** Rebuilds entity meshes to match the view and parks each on its tile. */
  syncEntities(view: ViewState): void;
  /** Places one entity at a fractional tile position; used by the move tween. */
  placeEntity(id: EntityId, x: number, y: number): void;
  /** 0 = untouched, 1 = fully flashed. Used by the damage animation. */
  flashEntity(id: EntityId, amount: number): void;
  /**
   * Leans `attacker` toward `target` by `amount` (0 = home, 1 = at the target's edge). The swing
   * half of a strike; `syncEntities` puts the attacker back on its tile when the animation ends.
   */
  lungeEntity(attacker: EntityId, target: EntityId, amount: number): void;
  /**
   * How far an entity has folded up: 0 standing, 1 flat. `null` hands the pose back to the view,
   * which draws anything with no hp left as down. The death animation drives this, and
   * `syncEntities` respects it — otherwise the diff that dropped hp to zero would snap the capsule
   * flat a frame before the death animation had a chance to play it.
   */
  setCollapse(id: EntityId, amount: number | null): void;
  setHover(tile: Tile | null): void;
  /** The tile the player clicked with nothing selected. Null clears the marker. */
  setTileMarker(tile: Tile | null): void;
  /** 1 fits the whole map; larger moves the camera in. Clamped to sensible bounds. */
  setZoom(zoom: number): void;
  /**
   * Slide the camera across the ground plane, in screen-space pixels. Screen-space rather than
   * world-space because a drag should move the map under the cursor by the distance dragged,
   * whatever the isometric angle happens to be.
   */
  panByPixels(dx: number, dy: number): void;
  /** Back to the framed default. */
  recentre(): void;
  /**
   * Dead space on the right that a fixed overlay covers, in CSS pixels. The map is centred on the
   * origin, so without this it centres under the panel and reads as off-centre.
   */
  setViewportInset(rightPx: number): void;
  setSelected(id: EntityId | null): void;
  /** What is under a pointer given in normalised device coordinates. */
  pick(ndc: Vector2): Pick;
  /** Screen position (CSS pixels) of an entity's head, for the floating damage number. */
  projectEntity(id: EntityId, width: number, height: number): { x: number; y: number } | null;
  /** Screen position (CSS pixels) of the centre of a tile's top face. */
  projectTile(tile: Tile, width: number, height: number): { x: number; y: number } | null;
  resize(width: number, height: number): void;
}

export function createGameScene(): GameScene {
  const scene = new Scene();
  scene.background = new Color(0x0b0d10);

  const camera = new OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  const tiles = new Group();
  const actors = new Group();
  scene.add(tiles, actors);

  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(6, 12, 4);
  scene.add(key, new AmbientLight(0x8899aa, 1.4));

  const tileGeometry = new BoxGeometry(TILE_SIZE * 0.98, 1, TILE_SIZE * 0.98);
  const capsuleGeometry = new CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_LENGTH, 4, 12);

  const hover = new Mesh(
    new BoxGeometry(TILE_SIZE, 0.04, TILE_SIZE),
    new MeshStandardMaterial({
      color: 0xffe08a,
      emissive: 0x6b5518,
      transparent: true,
      opacity: 0.8,
    }),
  );
  hover.visible = false;
  scene.add(hover);

  const marker = new Mesh(
    new BoxGeometry(TILE_SIZE * 0.9, 0.06, TILE_SIZE * 0.9),
    new MeshStandardMaterial({ color: 0x8ecae6, emissive: 0x1d4c63 }),
  );
  marker.visible = false;
  scene.add(marker);

  const ring = new Mesh(
    new RingGeometry(CAPSULE_RADIUS + 0.06, CAPSULE_RADIUS + 0.16, 28),
    new MeshStandardMaterial({ color: 0xffd166, emissive: 0x6b5518 }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  scene.add(ring);

  const raycaster = new Raycaster();
  const entityMeshes = new Map<EntityId, Mesh<CapsuleGeometry, MeshStandardMaterial>>();
  const baseColors = new Map<EntityId, Color>();
  /** Entities whose pose an animation is driving, so `syncEntities` leaves them alone. */
  const collapsing = new Map<EntityId, number>();
  /** Where each capsule was last parked, so a lunge leans from home instead of compounding. */
  const homes = new Map<EntityId, Vector3>();
  let map: MapRecord | null = null;
  let selected: EntityId | null = null;
  let zoom = 1;
  // Camera offset across the ground plane, and the width of the overlay covering the right edge.
  let panX = 0;
  let panZ = 0;
  let viewportInset = 0;

  const disposeGroup = (group: Group): void => {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof Mesh) child.material.dispose();
    }
  };

  const setMap = (next: MapRecord): void => {
    map = next;
    disposeGroup(tiles);
    for (let y = 0; y < next.height; y += 1) {
      for (let x = 0; x < next.width; x += 1) {
        const cell = next.cells[y * next.width + x];
        if (!cell) continue;
        const top = visualTopY(next, { x, y });
        const height = TILE_THICKNESS + top;
        const mesh = new Mesh(
          tileGeometry,
          new MeshStandardMaterial({
            color: tileColor(cell.walkable, cell.elevation),
            roughness: 0.9,
            metalness: 0,
          }),
        );
        const point = tileToWorld(next, x, y);
        mesh.scale.y = height;
        mesh.position.set(point.x, top - height / 2, point.z);
        mesh.userData = { tile: { x, y } };
        tiles.add(mesh);
      }
    }
    frameCamera();
  };

  const placeEntity = (id: EntityId, x: number, y: number): void => {
    const mesh = entityMeshes.get(id);
    if (!mesh || !map) return;
    const point = tileToWorld(map, x, y);
    mesh.position.set(point.x, point.y + CAPSULE_HALF, point.z);
    homes.set(id, mesh.position.clone());
    if (selected === id) ring.position.set(point.x, point.y + 0.03, point.z);
  };

  /** 0 standing, 1 flat. An animation's override wins over the view's "this one has no hp left". */
  const poseOf = (id: EntityId, alive: boolean): number => collapsing.get(id) ?? (alive ? 0 : 1);

  const applyPose = (id: EntityId, alive: boolean): void => {
    const mesh = entityMeshes.get(id);
    if (!mesh) return;
    const down = poseOf(id, alive);
    mesh.scale.set(1, 1 - 0.75 * down, 1);
    mesh.material.opacity = 1 - 0.45 * down;
    mesh.material.transparent = down > 0;
  };

  const syncEntities = (view: ViewState): void => {
    for (const [id, mesh] of entityMeshes) {
      if (view.entities[id]) continue;
      actors.remove(mesh);
      mesh.material.dispose();
      entityMeshes.delete(id);
      baseColors.delete(id);
      collapsing.delete(id);
      homes.delete(id);
    }
    for (const entity of Object.values(view.entities)) {
      let mesh = entityMeshes.get(entity.id);
      if (!mesh) {
        const color = factionColor(entity.faction);
        mesh = new Mesh(
          capsuleGeometry,
          new MeshStandardMaterial({ color: color.clone(), roughness: 0.5, metalness: 0.1 }),
        );
        mesh.userData = { entity: entity.id };
        entityMeshes.set(entity.id, mesh);
        baseColors.set(entity.id, color);
        actors.add(mesh);
      }
      applyPose(entity.id, isAlive(entity));
      placeEntity(entity.id, entity.tile.x, entity.tile.y);
    }
  };

  const flashEntity = (id: EntityId, amount: number): void => {
    const mesh = entityMeshes.get(id);
    const base = baseColors.get(id);
    if (!mesh || !base) return;
    mesh.material.color.copy(base).lerp(new Color(0xff5a4a), Math.min(1, Math.max(0, amount)));
  };

  const lungeEntity = (attacker: EntityId, target: EntityId, amount: number): void => {
    const from = entityMeshes.get(attacker);
    const to = entityMeshes.get(target);
    const home = homes.get(attacker);
    if (!from || !to || !home) return;
    // Always from home, never from wherever the last frame left it: lerping in place would walk
    // the attacker into its target over the course of the swing.
    // A lean, not a teleport — at full extension it has closed most of the gap but is still
    // standing on its own side of it, so two capsules never occupy one tile.
    from.position.copy(home).lerp(to.position, Math.min(1, Math.max(0, amount)) * 0.45);
  };

  const setCollapse = (id: EntityId, amount: number | null): void => {
    if (amount === null) {
      // Hand the pose back without guessing at it: the caller clears the override at the end of
      // the animation and then syncs, and the view is the only thing that knows if this one lived.
      collapsing.delete(id);
      return;
    }
    collapsing.set(id, Math.min(1, Math.max(0, amount)));
    applyPose(id, false);
  };

  const setHover = (tile: Tile | null): void => {
    if (!map || !tile) {
      hover.visible = false;
      return;
    }
    const point = tileToWorld(map, tile.x, tile.y);
    hover.position.set(point.x, visualTopY(map, tile) + 0.03, point.z);
    hover.visible = true;
  };

  const setTileMarker = (tile: Tile | null): void => {
    if (!map || !tile) {
      marker.visible = false;
      return;
    }
    const point = tileToWorld(map, tile.x, tile.y);
    marker.position.set(point.x, visualTopY(map, tile) + 0.05, point.z);
    marker.visible = true;
  };

  const setSelected = (id: EntityId | null): void => {
    selected = id;
    ring.visible = id !== null && entityMeshes.has(id);
    const mesh = id === null ? undefined : entityMeshes.get(id);
    if (mesh)
      ring.position.set(mesh.position.x, mesh.position.y - CAPSULE_HALF + 0.03, mesh.position.z);
  };

  const worldTileOf = (position: Vector3): Tile | null => {
    if (!map) return null;
    return {
      x: Math.round(position.x / TILE_SIZE + (map.width - 1) / 2),
      y: Math.round(position.z / TILE_SIZE + (map.height - 1) / 2),
    };
  };

  const pick = (ndc: Vector2): Pick => {
    raycaster.setFromCamera(ndc, camera);
    for (const hit of raycaster.intersectObjects([actors, tiles], true)) {
      const data = hit.object.userData as { entity?: EntityId; tile?: Tile };
      if (data.entity !== undefined) {
        const mesh = entityMeshes.get(data.entity);
        const tile = mesh ? worldTileOf(mesh.position) : null;
        if (tile) return { kind: 'entity', id: data.entity, tile };
      }
      if (data.tile) return { kind: 'tile', tile: data.tile };
    }
    return { kind: 'none' };
  };

  const projectEntity = (
    id: EntityId,
    width: number,
    height: number,
  ): { x: number; y: number } | null => {
    const mesh = entityMeshes.get(id);
    if (!mesh) return null;
    const point = mesh.position
      .clone()
      .add(new Vector3(0, CAPSULE_HALF, 0))
      .project(camera);
    return { x: ((point.x + 1) / 2) * width, y: ((1 - point.y) / 2) * height };
  };

  const projectTile = (
    tile: Tile,
    width: number,
    height: number,
  ): { x: number; y: number } | null => {
    if (!map) return null;
    const world = tileToWorld(map, tile.x, tile.y);
    const point = new Vector3(world.x, visualTopY(map, tile) + 0.02, world.z).project(camera);
    return { x: ((point.x + 1) / 2) * width, y: ((1 - point.y) / 2) * height };
  };

  let viewportWidth = 1;
  let viewportHeight = 1;

  /**
   * The frustum, corrected for the part of the viewport a fixed overlay covers.
   *
   * `isoCameraFrame` fits the map to the *whole* viewport. Shifting that left by half the panel
   * is not enough: the map still spans the full width, so its right-hand tiles sit under the panel
   * and cannot be clicked at all. Widening the frustum by the same ratio shrinks the map into the
   * space that is actually visible, and the shift then centres it there. Both halves scale
   * together so the isometric projection stays square.
   */
  function frustum(): {
    halfWidth: number;
    halfHeight: number;
    shift: number;
    near: number;
    far: number;
  } {
    const frame = isoCameraFrame(map!, viewportWidth / viewportHeight, zoom);
    const visible = Math.max(1, viewportWidth - viewportInset);
    const scale = viewportWidth / visible;
    const halfWidth = frame.halfWidth * scale;
    const halfHeight = frame.halfHeight * scale;
    const worldPerPixel = (halfWidth * 2) / Math.max(1, viewportWidth);
    return {
      halfWidth,
      halfHeight,
      shift: (viewportInset / 2) * worldPerPixel,
      near: frame.near,
      far: frame.far,
    };
  }

  function frameCamera(): void {
    if (!map) return;
    const frame = isoCameraFrame(map, viewportWidth / viewportHeight, zoom);
    const { halfWidth, halfHeight, shift, near, far } = frustum();
    camera.left = -halfWidth - shift;
    camera.right = halfWidth - shift;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.near = near;
    camera.far = far;

    camera.position.set(frame.position.x + panX, frame.position.y, frame.position.z + panZ);
    camera.lookAt(frame.target.x + panX, frame.target.y, frame.target.z + panZ);
    camera.updateProjectionMatrix();
  }

  const panByPixels = (dx: number, dy: number): void => {
    if (!map) return;
    const worldPerPixel = (frustum().halfWidth * 2) / Math.max(1, viewportWidth);
    // Screen right/down mapped onto the ground plane for this fixed isometric yaw. Dragging
    // moves the world with the cursor, so the deltas are negated.
    const right = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };
    const down = { x: Math.SQRT1_2, z: Math.SQRT1_2 };
    panX -= (dx * right.x + dy * down.x) * worldPerPixel;
    panZ -= (dx * right.z + dy * down.z) * worldPerPixel;
    const limit = Math.max(map.width, map.height) * TILE_SIZE;
    panX = Math.min(limit, Math.max(-limit, panX));
    panZ = Math.min(limit, Math.max(-limit, panZ));
    frameCamera();
  };

  const recentre = (): void => {
    panX = 0;
    panZ = 0;
    zoom = 1;
    frameCamera();
  };

  const setViewportInset = (rightPx: number): void => {
    viewportInset = Math.max(0, rightPx);
    frameCamera();
  };

  const setZoom = (next: number): void => {
    zoom = Math.min(4, Math.max(0.6, next));
    frameCamera();
  };

  const resize = (width: number, height: number): void => {
    viewportWidth = Math.max(1, width);
    viewportHeight = Math.max(1, height);
    frameCamera();
  };

  return {
    scene,
    camera,
    setMap,
    syncEntities,
    placeEntity,
    flashEntity,
    lungeEntity,
    setCollapse,
    setHover,
    setTileMarker,
    setZoom,
    panByPixels,
    recentre,
    setViewportInset,
    setSelected,
    pick,
    projectEntity,
    projectTile,
    resize,
  };
}
