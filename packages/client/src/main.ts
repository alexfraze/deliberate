/**
 * Client entry point: renderer + scene + input + the diff-driven animation queue, wired to either
 * the real server or the offline fixture stand-in (`?fixture=1`).
 *
 * The client never holds authoritative state. It renders the last snapshot with the diff stream
 * folded on top (`view.ts`) and sends every action to the server as an `intent`.
 */
import {
  DEFAULT_ROOM,
  PROTOCOL_VERSION,
  type EntityId,
  type MapRecord,
  type ServerMessage,
  type Tile,
} from '@deliberate/protocol';
import { REVISION, Vector2 } from 'three/webgpu';

import { AnimationQueue, samplePath, type Animation, type QueueEvent } from './animation.js';
import { cellAt } from './grid.js';
import { createHud, type FloatingNumber } from './hud.js';
import { createRenderer } from './renderer.js';
import { createGameScene } from './scene.js';
import { resolvePick } from './selection.js';
import { connectFixture, connectWebSocket, useFixtureMode, type Transport } from './transport.js';
import { applyDiffToView, emptyView, viewFromSnapshot, type ViewState } from './view.js';

const app = document.getElementById('app') ?? document.body;
const hudElement =
  document.getElementById('hud') ?? document.body.appendChild(document.createElement('div'));
const overlay =
  document.getElementById('overlay') ?? document.body.appendChild(document.createElement('div'));

const hud = createHud(hudElement, overlay);
const scene = createGameScene();
const queue = new AnimationQueue();
const floats = new Map<Animation, FloatingNumber>();

let view: ViewState = emptyView();
let selected: EntityId | null = null;
let turn = 0;

const { renderer, backend } = await createRenderer();
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
app.appendChild(renderer.domElement);
hud.setBackend(`${backend} · three r${REVISION} · protocol v${PROTOCOL_VERSION}`);

function viewport(): { width: number; height: number } {
  return {
    width: app.clientWidth || window.innerWidth,
    height: app.clientHeight || window.innerHeight,
  };
}

function resize(): void {
  const { width, height } = viewport();
  renderer.setSize(width, height, false);
  scene.resize(width, height);
}
window.addEventListener('resize', resize);
resize();

function describeSelection(id: EntityId | null): string | null {
  if (id === null) return null;
  const entity = view.entities[id];
  if (!entity) return id;
  return `${entity.name} (${entity.faction}) · ${entity.hp}/${entity.maxHp} hp · (${entity.tile.x}, ${entity.tile.y})`;
}

function setSelected(id: EntityId | null): void {
  selected = id;
  scene.setSelected(id);
  hud.setSelection(describeSelection(id));
}

// --- server messages -------------------------------------------------------------------------

function onMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'snapshot': {
      turn = message.turn;
      queue.clear();
      view = viewFromSnapshot(message.snapshot);
      if (view.map) scene.setMap(view.map);
      scene.syncEntities(view);
      resize();
      setSelected(selected !== null && view.entities[selected] ? selected : null);
      hud.setHint(`joined · ${Object.keys(view.entities).length} entities on ${view.mapId}`);
      return;
    }
    case 'diffs': {
      turn = message.turn;
      queue.enqueue(message.diffs);
      hud.setError(null);
      return;
    }
    case 'error': {
      hud.setError(message.reason);
      return;
    }
    case 'preview': {
      hud.setHint(message.text);
      return;
    }
    case 'narration': {
      hud.setHint(message.chunk);
      return;
    }
  }
}

const transport: Transport = useFixtureMode(location.search, location.hash)
  ? connectFixture({ onMessage, onStatus: (status) => hud.setStatus(`fixture (${status})`) })
  : connectWebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, {
      onMessage,
      onStatus: (status) => hud.setStatus(status),
    });

// --- animation -------------------------------------------------------------------------------

function onAnimationEvent(event: QueueEvent): void {
  const animation = event.animation;
  if (animation.kind === 'move' && event.type === 'progress') {
    const point = samplePath(animation.waypoints, event.t);
    scene.placeEntity(animation.diff.entity, point.x, point.y);
  }
  if (animation.kind === 'damage') {
    const { target, amount } = animation.diff;
    if (event.type === 'start') {
      floats.set(animation, hud.floatNumber(`-${amount}`, '#ff6b5a'));
    } else if (event.type === 'progress') {
      scene.flashEntity(target, Math.sin(Math.min(1, event.t) * Math.PI));
      const { width, height } = viewport();
      const screen = scene.projectEntity(target, width, height);
      if (screen) floats.get(animation)?.update(screen.x, screen.y, event.t);
    } else {
      scene.flashEntity(target, 0);
      floats.get(animation)?.remove();
      floats.delete(animation);
    }
  }
  if (event.type === 'finish') {
    applyDiffToView(view, animation.diff);
    scene.syncEntities(view);
    if (selected !== null) hud.setSelection(describeSelection(selected));
  }
}

let lastFrame = performance.now();
function frame(now: number): void {
  const dt = now - lastFrame;
  lastFrame = now;
  for (const event of queue.advance(dt)) onAnimationEvent(event);
  renderer.render(scene.scene, scene.camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- input -----------------------------------------------------------------------------------

const pointer = new Vector2();
let zoom = 1;

function toNdc(event: PointerEvent | WheelEvent): Vector2 {
  const rect = renderer.domElement.getBoundingClientRect();
  return pointer.set(
    ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
    -(((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1),
  );
}

let hovered: Tile | null = null;
renderer.domElement.addEventListener('pointermove', (event) => {
  const pick = scene.pick(toNdc(event));
  hovered = pick.kind === 'none' ? null : pick.tile;
  scene.setHover(hovered);
  renderer.domElement.style.cursor = pick.kind === 'entity' ? 'pointer' : 'default';
});

function describeTile(map: MapRecord | null, tile: Tile): string {
  const cell = map ? cellAt(map, tile) : undefined;
  if (!cell) return `tile (${tile.x}, ${tile.y})`;
  return `tile (${tile.x}, ${tile.y}) · ${cell.walkable ? 'walkable' : 'blocked'} · elevation ${cell.elevation}`;
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const pick = scene.pick(toNdc(event));
  const result = resolvePick(selected, pick);
  setSelected(result.selected);
  // With nothing selected, a click just inspects the tile; with an entity selected it is a move.
  const marked = pick.kind === 'tile' && result.intent === null ? pick.tile : null;
  scene.setTileMarker(marked);
  if (marked) hud.setHint(describeTile(view.map, marked));
  else if (result.hint !== null) hud.setHint(result.hint);
  if (result.intent) {
    hud.setError(null);
    transport.send({ type: 'intent', room: DEFAULT_ROOM, turn, intent: result.intent });
  }
});

renderer.domElement.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    zoom = Math.min(4, Math.max(0.6, zoom * (event.deltaY > 0 ? 0.9 : 1.1)));
    scene.setZoom(zoom);
  },
  { passive: false },
);

window.addEventListener('beforeunload', () => transport.close());
