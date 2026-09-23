/**
 * The three.js scene: an isometric orthographic camera over the map, one box per `TileCell`,
 * a capsule per entity coloured by faction, a hover highlight, and a selection ring.
 *
 * Everything here is presentation. It reads a `ViewState` (itself derived from snapshot + diffs)
 * and never decides anything about the game; picking returns what was under the cursor and leaves
 * the rules to `selection.ts`.
 *
 * **The look (ALE-34) is graphic, not atmospheric.** Every colour comes from `palette.ts`; nothing
 * here invents one. Three rules run through the whole file:
 *
 * 1. *Three lights, one shadow.* A hard key that casts, a hemisphere fill so shadowed faces stay
 *    coloured rather than black, and a low rim from behind that draws a bright edge along every
 *    silhouette. The rim is what makes a capsule read as a figure standing on the floor instead of
 *    a shape lying on it, and it is the single cheapest thing in here.
 * 2. *Signals are unlit.* Hover, the click marker and the selection ring are `MeshBasicMaterial`.
 *    They are UI that happens to live in the scene, and no lighting change may be allowed to dim
 *    them — legibility is not negotiable against mood.
 * 3. *The map is a board.* A plinth under the tiles gives the composition an edge and fills the
 *    gutters between tiles, so the grid reads as a deliberate lattice rather than floating squares.
 */
import type { EntityId, MapRecord, Tile, TileCell } from '@deliberate/protocol';
import {
  BasicShadowMap,
  BoxGeometry,
  CapsuleGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  Raycaster,
  RingGeometry,
  Scene,
  type Vector2,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';

import {
  TILE_SIZE,
  TILE_THICKNESS,
  clampZoom,
  isoCameraFrame,
  tileToWorld,
  visualTopY,
} from './grid.js';
import { factionColor, tileColor, type Palette } from './palette.js';
import type { Pick } from './selection.js';
import { entitiesHere, isAlive, type ViewState } from './view.js';

/**
 * A unit is an icon, so it is drawn a little larger than life: big enough to read at the zoom that
 * fits the whole map, still under half a tile so two neighbours never overlap.
 */
const CAPSULE_RADIUS = 0.3;
const CAPSULE_LENGTH = 0.62;
const CAPSULE_HALF = CAPSULE_RADIUS + CAPSULE_LENGTH / 2;

/** How far the board extends past the map, in tiles. The visible edge of the composition. */
const BOARD_MARGIN = 0.55;
const BOARD_THICKNESS = 0.9;
/**
 * The board's top sits just under the floor surface, so the 2% gutter between tile boxes shows
 * board rather than empty space. That is the grid: a lattice of recessed lines, no wireframe.
 */
const BOARD_TOP = -0.03;

export interface GameScene {
  readonly scene: Scene;
  readonly camera: OrthographicCamera;
  /** Repaint every material and light for a new theme. Nothing is rebuilt; only colours change. */
  setPalette(palette: Palette): void;
  /** Turns the shadow map on and points the renderer at the hard filter the look asks for. */
  configureRenderer(renderer: WebGPURenderer): void;
  setMap(map: MapRecord): void;
  /**
   * Rebuilds entity meshes to match the view and parks each on its tile. Only the entities on the
   * rendered map get a mesh: after a crossing (ALE-43) everyone left behind is disposed, so a
   * capsule can never be drawn at a tile that means somewhere else now.
   */
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
   * Dead space that fixed overlays cover, in CSS pixels: the control panel on the right, and the
   * dialogue thread on the left (ALE-35). The map is centred on the origin, so without this it
   * centres under them and reads as off-centre.
   */
  setViewportInset(rightPx: number, leftPx?: number): void;
  setSelected(id: EntityId | null): void;
  /** What is under a pointer given in normalised device coordinates. */
  pick(ndc: Vector2): Pick;
  /** Screen position (CSS pixels) of an entity's head, for the floating damage number. */
  projectEntity(id: EntityId, width: number, height: number): { x: number; y: number } | null;
  /** Screen position (CSS pixels) of the centre of a tile's top face. */
  projectTile(tile: Tile, width: number, height: number): { x: number; y: number } | null;
  resize(width: number, height: number): void;
}

export function createGameScene(palette: Palette): GameScene {
  let colors = palette;
  const scene = new Scene();
  scene.background = new Color(colors.surface);

  const camera = new OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  const tiles = new Group();
  const actors = new Group();
  scene.add(tiles, actors);

  // --- the rig -----------------------------------------------------------------------------
  // Key: from the screen's upper left and only 45 degrees up, so shadows are as long as the thing
  // casting them and fall down-and-right into open floor where you can actually see them. A
  // steeper sun would be more flattering and would say nothing about height.
  const key = new DirectionalLight(new Color(colors.key), 2.5);
  key.position.set(-8, 9, -4);
  key.castShadow = true;
  // Hemisphere rather than ambient: the floor's own hue bounces back up into the undersides, which
  // is what stops a hard-lit flat scene from reading as cut-out shapes on a black card.
  const fill = new HemisphereLight(new Color(colors.sky), new Color(colors.bounce), 1.35);
  // Rim: low, from behind, and the most saturated light in the scene. It never lights a surface
  // the camera can see straight on — only the grazing edges — so its whole job is silhouette.
  const rim = new DirectionalLight(new Color(colors.rim), 1.9);
  rim.position.set(11, 2, -13);
  scene.add(key, fill, rim);

  const tileGeometry = new BoxGeometry(TILE_SIZE * 0.98, 1, TILE_SIZE * 0.98);
  const capsuleGeometry = new CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_LENGTH, 6, 16);

  /** The plinth. Sized by `setMap`; here so the theme switch has something to repaint. */
  const board = new Mesh(
    new BoxGeometry(1, BOARD_THICKNESS, 1),
    new MeshStandardMaterial({ color: new Color(colors.board), roughness: 1, metalness: 0 }),
  );
  board.receiveShadow = true;
  board.visible = false;
  scene.add(board);

  // Signals are unlit (`MeshBasicMaterial`): a colour grade, a theme switch or a light that moved
  // must not be able to take the selection ring with it.
  const hover = new Mesh(
    new BoxGeometry(TILE_SIZE, 0.04, TILE_SIZE),
    new MeshBasicMaterial({ color: new Color(colors.hover), transparent: true, opacity: 0.55 }),
  );
  hover.visible = false;
  scene.add(hover);

  const marker = new Mesh(
    new BoxGeometry(TILE_SIZE * 0.9, 0.06, TILE_SIZE * 0.9),
    new MeshBasicMaterial({ color: new Color(colors.marker) }),
  );
  marker.visible = false;
  scene.add(marker);

  const ring = new Mesh(
    new RingGeometry(CAPSULE_RADIUS + 0.08, CAPSULE_RADIUS + 0.22, 32),
    new MeshBasicMaterial({ color: new Color(colors.select) }),
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
  // Camera offset across the ground plane, and the widths of the overlays covering each edge.
  let panX = 0;
  let panZ = 0;
  let insetRight = 0;
  let insetLeft = 0;

  const disposeGroup = (group: Group): void => {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof Mesh) child.material.dispose();
    }
  };

  /** Repaints one tile from its own cell. Kept separate so a theme switch is a second pass. */
  const paintTile = (mesh: Mesh<BoxGeometry, MeshStandardMaterial>): void => {
    const data = mesh.userData as { tile: Tile; cell: TileCell };
    mesh.material.color.set(tileColor(colors, data.cell, data.tile));
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
          // Roughness 1, metalness 0: a flat diffuse surface with no specular glint on it. A
          // highlight would be the renderer describing a material the tile does not have.
          new MeshStandardMaterial({ roughness: 1, metalness: 0 }),
        );
        const point = tileToWorld(next, x, y);
        mesh.scale.y = height;
        mesh.position.set(point.x, top - height / 2, point.z);
        mesh.userData = { tile: { x, y }, cell };
        // Walls cast; everything receives. A floor tile casting onto its neighbour would only ever
        // produce shadow acne along the gutters, and it has nothing to cast.
        mesh.castShadow = !cell.walkable || cell.elevation > 0;
        mesh.receiveShadow = true;
        paintTile(mesh);
        tiles.add(mesh);
      }
    }
    const width = (next.width + BOARD_MARGIN * 2) * TILE_SIZE;
    const depth = (next.height + BOARD_MARGIN * 2) * TILE_SIZE;
    board.scale.set(width, 1, depth);
    board.position.set(0, BOARD_TOP - BOARD_THICKNESS / 2, 0);
    board.visible = true;
    fitShadowCamera(next);
    frameCamera();
  };

  /**
   * Points the key light's shadow frustum at exactly this map. An orthographic shadow camera sized
   * to the map instead of to some constant is what keeps the shadow crisp: the same texture covers
   * the smallest area it can, so the hard edge stays hard on a big map as well as a small one.
   */
  function fitShadowCamera(next: MapRecord): void {
    const radius = Math.hypot(next.width, next.height) * TILE_SIZE * 0.6 + 2;
    const shadow = key.shadow;
    shadow.mapSize.set(2048, 2048);
    shadow.camera.left = -radius;
    shadow.camera.right = radius;
    shadow.camera.top = radius;
    shadow.camera.bottom = -radius;
    shadow.camera.near = 0.5;
    shadow.camera.far = radius * 4 + 20;
    shadow.bias = -0.0006;
    shadow.normalBias = 0.04;
    shadow.camera.updateProjectionMatrix();
  }

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

  /**
   * Sets a unit's base colour from its faction and the current theme. A trace of the same hue as
   * emissive keeps a unit recognisable inside the key light's own shadow — an ally behind a wall
   * should still read as an ally rather than as a dark lozenge.
   */
  const paintEntity = (id: EntityId): void => {
    const mesh = entityMeshes.get(id);
    if (!mesh) return;
    const { faction } = mesh.userData as { faction: string };
    const color = new Color(factionColor(colors, faction));
    baseColors.set(id, color);
    mesh.material.color.copy(color);
    mesh.material.emissive.copy(color).multiplyScalar(0.16);
  };

  const syncEntities = (view: ViewState): void => {
    const here = entitiesHere(view);
    const drawn = new Set(here.map((entity) => entity.id));
    for (const [id, mesh] of entityMeshes) {
      if (drawn.has(id)) continue;
      actors.remove(mesh);
      mesh.material.dispose();
      entityMeshes.delete(id);
      baseColors.delete(id);
      collapsing.delete(id);
      homes.delete(id);
    }
    for (const entity of here) {
      let mesh = entityMeshes.get(entity.id);
      if (!mesh) {
        mesh = new Mesh(
          capsuleGeometry,
          new MeshStandardMaterial({ roughness: 0.65, metalness: 0 }),
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData = { entity: entity.id, faction: entity.faction };
        entityMeshes.set(entity.id, mesh);
        actors.add(mesh);
        paintEntity(entity.id);
      }
      applyPose(entity.id, isAlive(entity));
      placeEntity(entity.id, entity.tile.x, entity.tile.y);
    }
  };

  const flashEntity = (id: EntityId, amount: number): void => {
    const mesh = entityMeshes.get(id);
    const base = baseColors.get(id);
    if (!mesh || !base) return;
    mesh.material.color.copy(base).lerp(new Color(colors.flash), Math.min(1, Math.max(0, amount)));
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
   *
   * The shift is *added* to both edges, which slides the view window right in world space and so
   * moves the board left on screen, out from under the panel. It used to be subtracted, which
   * pushed the board the other way — further under the panel, with the dead space opening up on
   * the empty left instead. The map was legibly off-centre in every screenshot; ALE-34 noticed
   * while measuring how much of the frame the board actually fills.
   *
   * With an overlay on each edge the widths add — both are hidden width — but the shift takes
   * their *difference*, so two equal overlays leave the board centred where it already was.
   */
  function frustum(): {
    halfWidth: number;
    halfHeight: number;
    shift: number;
    near: number;
    far: number;
  } {
    const frame = isoCameraFrame(map!, viewportWidth / viewportHeight, zoom);
    const visible = Math.max(1, viewportWidth - insetRight - insetLeft);
    const scale = viewportWidth / visible;
    const halfWidth = frame.halfWidth * scale;
    const halfHeight = frame.halfHeight * scale;
    const worldPerPixel = (halfWidth * 2) / Math.max(1, viewportWidth);
    return {
      halfWidth,
      halfHeight,
      shift: ((insetRight - insetLeft) / 2) * worldPerPixel,
      near: frame.near,
      far: frame.far,
    };
  }

  function frameCamera(): void {
    if (!map) return;
    const frame = isoCameraFrame(map, viewportWidth / viewportHeight, zoom);
    const { halfWidth, halfHeight, shift, near, far } = frustum();
    camera.left = -halfWidth + shift;
    camera.right = halfWidth + shift;
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

  /**
   * A theme switch. Every colour in the scene is a palette token, so this is a repaint rather than
   * a rebuild: no geometry is touched, nothing is disposed, and the camera does not move.
   */
  const setPalette = (next: Palette): void => {
    colors = next;
    scene.background = new Color(colors.surface);
    key.color.set(colors.key);
    fill.color.set(colors.sky);
    fill.groundColor.set(colors.bounce);
    rim.color.set(colors.rim);
    board.material.color.set(colors.board);
    hover.material.color.set(colors.hover);
    marker.material.color.set(colors.marker);
    ring.material.color.set(colors.select);
    for (const mesh of tiles.children) {
      if (mesh instanceof Mesh) paintTile(mesh as Mesh<BoxGeometry, MeshStandardMaterial>);
    }
    for (const id of entityMeshes.keys()) paintEntity(id);
  };

  /**
   * Shadows are a renderer setting, and the renderer is made before the scene, so the scene asks
   * for what it needs rather than leaving `main.ts` to remember. `BasicShadowMap` is the choice
   * the direction makes: an unfiltered, aliased, *hard* edge. Softening it would be the only
   * atmospheric thing in the frame.
   */
  const configureRenderer = (renderer: WebGPURenderer): void => {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = BasicShadowMap;
  };

  const setViewportInset = (rightPx: number, leftPx = 0): void => {
    insetRight = Math.max(0, rightPx);
    insetLeft = Math.max(0, leftPx);
    frameCamera();
  };

  const setZoom = (next: number): void => {
    zoom = clampZoom(next);
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
    setPalette,
    configureRenderer,
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
