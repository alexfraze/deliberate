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

import {
  AnimationQueue,
  collapseAmount,
  samplePath,
  strikePhase,
  type Animation,
  type QueueEvent,
} from './animation.js';
import { createGrade } from './grade.js';
import { ZOOM_STEP, cellAt, clampZoom } from './grid.js';
import { createHud, type FloatingNumber } from './hud.js';
import { cssVariables, otherTheme, paletteFor, resolveTheme, type ThemeName } from './palette.js';
import { initiativeView } from './initiative.js';
import { createDeliberatePanel } from './panel.js';
import { createRenderer } from './renderer.js';
import { createGameScene } from './scene.js';
import { resolvePick, type Pick } from './selection.js';
import { createSpeculator } from './speculate.js';
import { NO_GM } from './deliberate.js';
import { replayName } from './replay.js';
import {
  connectFixture,
  connectReplay,
  connectWebSocket,
  fetchGmHealth,
  useFixtureMode,
  type Transport,
} from './transport.js';
import { applyDiffToView, emptyView, viewFromSnapshot, type ViewState } from './view.js';

const app = document.getElementById('app') ?? document.body;
const hudElement =
  document.getElementById('hud') ?? document.body.appendChild(document.createElement('div'));
const overlay =
  document.getElementById('overlay') ?? document.body.appendChild(document.createElement('div'));
const panelElement =
  document.getElementById('deliberate') ?? document.body.appendChild(document.createElement('div'));

/**
 * The theme (ALE-34). One token set drives both the DOM overlay and the three.js scene, so the
 * HUD, the turn-order chips and the board can never end up lit for different times of day.
 * `?theme=light` pins it; otherwise the browser's own preference decides.
 */
let theme: ThemeName = resolveTheme(
  location.search,
  location.hash,
  !window.matchMedia?.('(prefers-color-scheme: light)').matches,
);

function applyTheme(next: ThemeName): void {
  theme = next;
  const palette = paletteFor(next);
  for (const [name, value] of Object.entries(cssVariables(palette))) {
    document.documentElement.style.setProperty(name, value);
  }
  document.documentElement.dataset['theme'] = next;
  document.documentElement.style.colorScheme = next;
  scene.setPalette(palette);
  grade.setPalette(palette);
  refreshBackendLine();
}

const hud = createHud(hudElement, overlay);
const scene = createGameScene(paletteFor(theme));
const queue = new AnimationQueue();
const floats = new Map<Animation, FloatingNumber>();

let view: ViewState = emptyView();

/**
 * The preview-then-GO panel (ALE-32). **On by default** since ALE-39: with it off a click commits
 * straight to the engine and no model is ever asked, which is the M0 path and was silently the
 * out-of-the-box experience. With it on, a click stages an action, the server previews it against
 * a clone of the engine, and nothing happens until GO. Either way the panel now says which.
 */
const panel = createDeliberatePanel(panelElement, {
  nameOf: (id) => view.entities[id]?.name ?? id,
});

const fixtureMode = useFixtureMode(location.search, location.hash);
/** `?replay=<name>` watches a recorded bank session play back (ALE-19). Nothing is interactive. */
const replay = replayName(location.search, location.hash);
// Whether a game master is behind this session at all (ALE-39). Fixture mode has no server to ask.
void (fixtureMode ? Promise.resolve(NO_GM) : fetchGmHealth()).then((gm) => panel.setGm(gm));

let selected: EntityId | null = null;
let turn = 0;
let hash = '';
/**
 * True between sending a `preview_request` or `go` and the server answering. Speculation must
 * never race a preview the player actually asked for: the server serialises the two anyway, so a
 * frame sent now would only queue the player behind a guess.
 */
let awaitingServer = false;

/** The renderer line, which names the theme so a screenshot says which one it is. */
function refreshBackendLine(): void {
  hud.setBackend(
    `${backend} · three r${REVISION} · protocol v${PROTOCOL_VERSION} · ${theme}${grade.active ? '' : ' · ungraded'}`,
  );
}

const { renderer, backend } = await createRenderer();
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
scene.configureRenderer(renderer);
app.appendChild(renderer.domElement);
/** Post-processing: a colour grade, no SSAO and no bloom. `grade.ts` argues the case. */
const grade = createGrade(renderer, scene.scene, scene.camera, paletteFor(theme));
applyTheme(theme);

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

/** The HUD's turn line and the panel's encounter note come from the same fact: is initiative on. */
function refreshTurn(): void {
  hud.setTurn(describeTurn());
  hud.setInitiative(initiativeView(view));
  panel.setEncounter(view.initiative !== null);
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
      speculator.turn(turn);
      awaitingServer = false;
      refreshTurn();
      hud.setHint(`joined · ${Object.keys(view.entities).length} entities on ${view.mapId}`);
      return;
    }
    case 'diffs': {
      turn = message.turn;
      hash = message.hash;
      queue.enqueue(message.diffs);
      hud.setError(null);
      // A new turn is a new world, so every key the cache holds for this one is dead. The
      // pointer's allowance starts again with it.
      speculator.turn(turn);
      awaitingServer = false;
      // The diffs ARE the outcome. Resolve may still be running NPC turns behind them, and each
      // NPC turn sends its own diffs which refresh this deadline — but if nothing more arrives,
      // the turn is simply over and the indicator must not keep claiming otherwise. In a replay
      // nothing is acting at all — it already happened — so there is nothing to wait for.
      if (!replay) panel.busy('the world is acting', 6000);
      return;
    }
    case 'error': {
      awaitingServer = false;
      hud.setError(message.reason);
      panel.idle();
      panel.reset(message.reason);
      return;
    }
    case 'preview': {
      // Nothing in here has happened: it is what the game master says would happen if you GO.
      turn = message.turn;
      awaitingServer = false;
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

const transport: Transport = replay
  ? // Watch a recorded session play back through the real render path (ALE-19). Turns are paced by
    // the animation queue draining, so nothing ever overlaps the turn before it.
    connectReplay(replay, {
      onMessage,
      onStatus: (status) => hud.setStatus(status),
      idle: () => queue.idle,
    })
  : fixtureMode
    ? connectFixture({ onMessage, onStatus: (status) => hud.setStatus(`fixture (${status})`) })
    : connectWebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, {
        onMessage,
        onStatus: (status) => hud.setStatus(status),
      });

/**
 * Speculative preview warming (ALE-40). The player deliberates for seconds and a preview takes
 * tens of them, so the pointer resting on an action is taken as a cheap bet that they will pick
 * it: the server warms the very same `(state, intent)` cache entry their `preview_request` will
 * look up, and if the bet lands the preview comes back in ~0 s instead of ~30.
 *
 * It is a bet with real money on it — one model call each — so `speculate.ts` is stingy on dwell,
 * on repeats and on a per-turn ceiling, `speculationCandidate` refuses to bet at all unless the
 * conditions are exactly right, and the server enforces its own ceiling regardless of what this
 * page sends. `?speculate=0` turns it off here; `GM_SPECULATE=off` turns it off for everyone.
 */
const speculator = createSpeculator({
  enabled: new URLSearchParams(location.search).get('speculate') !== '0',
  send: (intent) => transport.send({ type: 'speculate', room: DEFAULT_ROOM, turn, intent }),
});

/** A real frame is going out: disarm the guess, and stop guessing until the server answers. */
function askingServer(): void {
  speculator.cancel();
  awaitingServer = true;
}

/**
 * What, if anything, is worth warming for the thing under the cursor — and every reason not to.
 *
 * The intent is composed by `resolvePick`, the same pure function the click itself goes through,
 * so what is warmed is *the preview the player would get*, keyed identically. Guessing differently
 * from the click would spend the money and miss the cache, which is the worst of both.
 */
function speculationCandidate(pick: Pick): Intent | null {
  // Off: a click commits immediately, so there is no preview to warm.
  if (!panel.isOn()) return null;
  // The player is already waiting on the server, or driving the camera rather than choosing.
  if (awaitingServer || dragging) return null;
  // Free text is part of the cache key (`previewKey`), and half-typed text is a key that will
  // never be asked for. Warming it would pay for an answer to a question nobody asks.
  if (panel.text()) return null;
  return resolvePick(selected, pick).intent;
}

// --- animation -------------------------------------------------------------------------------

/**
 * A killing blow gets a brighter number than a scratch, so a death is legible at a glance. Both
 * come from the palette and are read per float, so they follow a theme switch mid-fight.
 */
const damageColor = (fatal: boolean): string =>
  fatal ? paletteFor(theme).kill : paletteFor(theme).damage;

function onAnimationEvent(event: QueueEvent): void {
  const animation = event.animation;
  if (animation.kind === 'move' && event.type === 'progress') {
    const point = samplePath(animation.waypoints, event.t);
    scene.placeEntity(animation.diff.entity, point.x, point.y);
  }
  if (animation.kind === 'damage') {
    const { target, amount, hpAfter } = animation.diff;
    if (event.type === 'start') {
      floats.set(animation, hud.floatNumber(`-${amount}`, damageColor(hpAfter <= 0)));
    } else if (event.type === 'progress') {
      // One diff, two beats: the attacker swings, then the target takes it. `strikePhase` owns
      // where the boundary is so the flash cannot start before the blow lands.
      const { lunge, hit } = strikePhase(animation, event.t);
      if (animation.attacker !== null) scene.lungeEntity(animation.attacker, target, lunge);
      scene.flashEntity(target, hit);
      const { width, height } = viewport();
      const screen = scene.projectEntity(target, width, height);
      // The number only starts drifting once it has been struck, so it rises out of the impact.
      if (screen) floats.get(animation)?.update(screen.x, screen.y, hit > 0 ? event.t : 0);
    } else {
      scene.flashEntity(target, 0);
      floats.get(animation)?.remove();
      floats.delete(animation);
    }
  }
  if (animation.kind === 'death') {
    const id = animation.diff.entity;
    if (event.type === 'progress') {
      scene.setCollapse(id, collapseAmount(event.t));
    } else if (event.type === 'finish') {
      // Hand the pose back to the view, which is about to be told this one is down.
      scene.setCollapse(id, null);
    }
  }
  if (event.type === 'finish') {
    applyDiffToView(view, animation.diff);
    scene.syncEntities(view);
    refreshTurn();
    if (selected !== null) hud.setSelection(describeSelection(selected));
  }
}

let lastFrame = performance.now();
function frame(now: number): void {
  const dt = now - lastFrame;
  lastFrame = now;
  for (const event of queue.advance(dt)) onAnimationEvent(event);
  grade.render();
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
  // Dwell, not movement: this only re-arms when the *target* changes, so the clock survives a
  // trembling hand and never starts on a pointer sweeping past.
  speculator.hover(speculationCandidate(pick));
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
  speculator.cancel();
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
  } else if (event.key === 't' || event.key === 'T') {
    // Both themes have to read, so both have to be one keystroke away while you are looking at it.
    applyTheme(otherTheme(theme));
    hud.setHint(`${theme} theme.`);
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
      askingServer();
      const text = panel.text();
      transport.send({
        type: 'preview_request',
        room: DEFAULT_ROOM,
        turn,
        intent: result.intent,
        ...(text ? { text } : {}),
      });
    } else {
      // No preview, no model: straight to the engine. The panel says so rather than leaving the
      // player to assume the instant result came from a game master (ALE-39).
      transport.send({ type: 'intent', room: DEFAULT_ROOM, turn, intent: result.intent });
      panel.noteTurn('engine');
      panel.busy('resolving the turn', 15000);
    }
  }
});

renderer.domElement.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    zoom = clampZoom(zoom * (event.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP));
    scene.setZoom(zoom);
  },
  { passive: false },
);

panel.onGo(() => {
  hud.setError(null);
  panel.committing();
  askingServer();
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
  askingServer();
  transport.send({ type: 'preview_request', room: DEFAULT_ROOM, turn, intent: null, text });
});
/**
 * Send a button-composed intent: previewed in deliberate mode, committed otherwise. Whether the
 * entity may do it is the engine's call, and its reason lands in the HUD.
 */
const sendButtonIntent = (intent: Intent): void => {
  hud.setError(null);
  if (panel.isOn()) {
    panel.stage(intent);
    askingServer();
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
    panel.noteTurn('engine');
    panel.busy('resolving the turn', 15000);
  }
};

panel.onEndTurn(() => {
  if (selected === null) {
    hud.setHint('Select an entity first, then end its turn.');
    return;
  }
  sendButtonIntent({ kind: 'end_turn', entity: selected });
});
panel.onWait(() => {
  if (selected === null) {
    hud.setHint('Select an entity first, then let time pass for it.');
    return;
  }
  // The out-of-combat verb (ALE-41): the clock moves on and the server gives the world a turn.
  // Legality is the engine's — inside an encounter it says to end the turn instead.
  sendButtonIntent({ kind: 'pass_time', entity: selected });
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
