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
  type Intent,
  type MapRecord,
  type ServerMessage,
  type Tile,
} from '@deliberate/protocol';
import { REVISION, Vector2 } from 'three/webgpu';

import { AnimationQueue, samplePath, type Animation, type QueueEvent } from './animation.js';
import { cellAt } from './grid.js';
import { createHud, type FloatingNumber } from './hud.js';
import { createDeliberatePanel } from './panel.js';
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
const panelElement =
  document.getElementById('deliberate') ?? document.body.appendChild(document.createElement('div'));

const hud = createHud(hudElement, overlay);
const scene = createGameScene();
const queue = new AnimationQueue();
const floats = new Map<Animation, FloatingNumber>();

let view: ViewState = emptyView();

/**
 * The preview-then-GO panel (ALE-32). Off by default: with it off a click commits immediately,
 * which is the M0 path the acceptance suite plays. With it on, a click stages an action, the
 * server previews it against a clone of the engine, and nothing happens until GO.
 */
const panel = createDeliberatePanel(panelElement, {
  nameOf: (id) => view.entities[id]?.name ?? id,
});

let selected: EntityId | null = null;
let turn = 0;
let hash = '';

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
  // The panel is a fixed overlay on the right. Tell the scene how much of the viewport it hides
  // so the map centres in what the player can see rather than behind it.
  const panelWidth = panelElement.getBoundingClientRect().width;
  scene.setViewportInset(panelWidth > 0 && panelWidth < width / 2 ? panelWidth + 24 : 0);
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

/**
 * Whose turn it is, from the diff stream alone. `TurnAdvanced` and `EconomySpent` are what put
 * this line on screen, so it is the visible proof that the client is driven by diffs and not by a
 * snapshot resent every turn.
 */
function describeTurn(): string | null {
  const init = view.initiative;
  if (!init) return null;
  const id = init.order[init.current];
  const name = id ? (view.entities[id]?.name ?? id) : 'nobody';
  const spent = init.turn ?? { movedFt: 0, actionUsed: false, bonusActionUsed: false };
  const action = spent.actionUsed ? 'action spent' : 'action ready';
  const bonus = spent.bonusActionUsed ? 'bonus spent' : 'bonus ready';
  return `${name} · round ${init.round} · moved ${spent.movedFt} ft · ${action} · ${bonus}`;
}

// --- server messages -------------------------------------------------------------------------

function onMessage(message: ServerMessage): void {
  switch (message.type) {
    case 'snapshot': {
      turn = message.turn;
      hash = message.hash;
      queue.clear();
      view = viewFromSnapshot(message.snapshot);
      if (view.map) scene.setMap(view.map);
      scene.syncEntities(view);
      resize();
      setSelected(selected !== null && view.entities[selected] ? selected : null);
      hud.setTurn(describeTurn());
      hud.setHint(`joined · ${Object.keys(view.entities).length} entities on ${view.mapId}`);
      return;
    }
    case 'diffs': {
      turn = message.turn;
      hash = message.hash;
      queue.enqueue(message.diffs);
      hud.setError(null);
      // The diffs ARE the outcome. Resolve may still be running NPC turns behind them, and each
      // NPC turn sends its own diffs which refresh this deadline — but if nothing more arrives,
      // the turn is simply over and the indicator must not keep claiming otherwise.
      panel.busy('the world is acting', 6000);
      return;
    }
    case 'error': {
      hud.setError(message.reason);
      panel.idle();
      panel.reset(message.reason);
      return;
    }
    case 'preview': {
      // Nothing in here has happened: it is what the game master says would happen if you GO.
      turn = message.turn;
      panel.showPreview(message.text, message.diffs);
      hud.setHint(message.text);
      return;
    }
    case 'narration': {
      panel.narrate(message.chunk, message.done);
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
    hud.setTurn(describeTurn());
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

// --- camera pan -------------------------------------------------------------------------------

let dragging = false;
let dragMoved = false;
let lastDrag = { x: 0, y: 0 };
const DRAG_SLOP = 4; // px; below this a drag is still a click

renderer.domElement.addEventListener('pointerdown', (event) => {
  // Left drag pans, and so does middle/right, but only left can also be a click.
  dragging = true;
  dragMoved = false;
  lastDrag = { x: event.clientX, y: event.clientY };
  renderer.domElement.setPointerCapture(event.pointerId);
});

renderer.domElement.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  const dx = event.clientX - lastDrag.x;
  const dy = event.clientY - lastDrag.y;
  if (!dragMoved && Math.hypot(dx, dy) < DRAG_SLOP) return;
  dragMoved = true;
  lastDrag = { x: event.clientX, y: event.clientY };
  scene.panByPixels(dx, dy);
});

const endDrag = (event: PointerEvent): void => {
  dragging = false;
  if (renderer.domElement.hasPointerCapture(event.pointerId)) {
    renderer.domElement.releasePointerCapture(event.pointerId);
  }
};
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

window.addEventListener('keydown', (event) => {
  // Not while typing into the speech box.
  if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)
    return;
  const step = event.shiftKey ? 160 : 60;
  if (event.key === 'ArrowLeft') scene.panByPixels(step, 0);
  else if (event.key === 'ArrowRight') scene.panByPixels(-step, 0);
  else if (event.key === 'ArrowUp') scene.panByPixels(0, step);
  else if (event.key === 'ArrowDown') scene.panByPixels(0, -step);
  else if (event.key === 'c' || event.key === 'C') {
    scene.recentre();
    zoom = 1;
    hud.setHint('Camera recentred.');
  } else return;
  event.preventDefault();
});

renderer.domElement.addEventListener('pointerup', (event) => {
  if (event.button !== 0) return;
  // A drag is a camera move, not a selection.
  if (dragMoved) return;
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
    if (panel.isOn()) {
      // Deliberate: ask for a preview. Clicking somewhere else replaces it — the server keeps only
      // the last preview, so changing your mind costs nothing and commits nothing.
      panel.stage(result.intent);
      const text = panel.text();
      transport.send({
        type: 'preview_request',
        room: DEFAULT_ROOM,
        turn,
        intent: result.intent,
        ...(text ? { text } : {}),
      });
    } else {
      transport.send({ type: 'intent', room: DEFAULT_ROOM, turn, intent: result.intent });
      panel.busy('resolving the turn', 15000);
    }
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

panel.onGo(() => {
  hud.setError(null);
  panel.committing();
  transport.send({ type: 'go', room: DEFAULT_ROOM, turn });
  panel.clearText();
});
panel.onToggle(() => {
  panel.reset();
  hud.setError(null);
});
panel.onSpeak(() => {
  const text = panel.text();
  if (!text) {
    hud.setHint('Type something first — then Say / Ask.');
    return;
  }
  if (!panel.isOn()) {
    // Free text only means anything if the game master is being consulted; without deliberate
    // mode a click goes straight to the engine, which has no idea what words are.
    hud.setError('Turn on deliberate mode to talk to the game master.');
    return;
  }
  // `intent: null` is the protocol's "ask only what the world does" — talk, do not act.
  hud.setError(null);
  panel.stage(null);
  transport.send({ type: 'preview_request', room: DEFAULT_ROOM, turn, intent: null, text });
});
panel.onEndTurn(() => {
  if (selected === null) {
    hud.setHint('Select an entity first, then end its turn.');
    return;
  }
  // Same path as any other intent: previewed in deliberate mode, committed otherwise. Whether
  // this entity may end its turn is the engine's call, and its reason lands in the HUD.
  const intent: Intent = { kind: 'end_turn', entity: selected };
  hud.setError(null);
  if (panel.isOn()) {
    panel.stage(intent);
    const text = panel.text();
    transport.send({
      type: 'preview_request',
      room: DEFAULT_ROOM,
      turn,
      intent,
      ...(text ? { text } : {}),
    });
  } else {
    transport.send({ type: 'intent', room: DEFAULT_ROOM, turn, intent });
    panel.busy('resolving the turn', 15000);
  }
});

window.addEventListener('beforeunload', () => transport.close());

// --- acceptance hook -------------------------------------------------------------------------

/**
 * What the ALE-13 acceptance suite needs to drive this page with real pointer events: where a tile
 * or an entity lands on screen under the isometric camera, whether the animation queue has drained,
 * and the last state hash the server sent (which the replayed recording must match).
 *
 * Read-only on purpose. It cannot send an intent or touch state; the suite clicks the canvas like
 * a player does, so what it exercises is the real input path.
 */
export interface AcceptanceHook {
  screenOfEntity(id: EntityId): { x: number; y: number } | null;
  screenOfTile(tile: Tile): { x: number; y: number } | null;
  /** Animations still to play. Zero means the view has caught up with every diff received. */
  pending(): number;
  /** The hash the server reported with the last snapshot or diffs frame. */
  hash(): string;
}

(window as unknown as { deliberate: AcceptanceHook }).deliberate = {
  screenOfEntity: (id) => scene.projectEntity(id, viewport().width, viewport().height),
  screenOfTile: (tile) => scene.projectTile(tile, viewport().width, viewport().height),
  pending: () => queue.pending,
  hash: () => hash,
};
