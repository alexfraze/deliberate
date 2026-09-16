/**
 * Where server messages come from. Two implementations behind one interface: the real WebSocket,
 * and a fixture stand-in (`?fixture=1`) that answers intents locally so the renderer can be
 * developed and smoke-tested while the server is still being built on another branch.
 */
import {
  DEFAULT_ROOM,
  PROTOCOL_VERSION,
  type ClientMessage,
  type Diff,
  type Intent,
  type ServerMessage,
  type Tile,
} from '@deliberate/protocol';

import { NO_GM, type GmAvailability } from './deliberate.js';
import { fixtureScript, fixtureSnapshot, fixtureSnapshotMessage } from './fixtures/index.js';
import { isWalkable, tileDistance } from './grid.js';
import { encodeClientMessage, parseServerMessage } from './messages.js';
import { parseRecording } from './replay.js';
import { applyDiffsToView, isAlive, viewFromSnapshot, type ViewState } from './view.js';

export interface TransportHandlers {
  onMessage(message: ServerMessage): void;
  /** Connection state for the HUD ('connecting', 'live', 'fixture', 'closed'). */
  onStatus(status: string): void;
}

export interface Transport {
  send(message: ClientMessage): void;
  close(): void;
}

export function connectWebSocket(url: string, handlers: TransportHandlers): Transport {
  const socket = new WebSocket(url);
  handlers.onStatus('connecting');
  socket.addEventListener('open', () => {
    handlers.onStatus('live');
    socket.send(
      encodeClientMessage({ type: 'join', room: DEFAULT_ROOM, protocol: PROTOCOL_VERSION }),
    );
  });
  socket.addEventListener('message', (event) => {
    const message = parseServerMessage(String(event.data));
    if (message) handlers.onMessage(message);
  });
  socket.addEventListener('close', () => handlers.onStatus('closed'));
  socket.addEventListener('error', () => handlers.onStatus('error'));
  return {
    send(message) {
      if (socket.readyState === WebSocket.OPEN) socket.send(encodeClientMessage(message));
    },
    close() {
      socket.close();
    },
  };
}

/** One 8-way step from `from` toward `to`. */
function stepToward(from: Tile, to: Tile): Tile {
  return { x: from.x + Math.sign(to.x - from.x), y: from.y + Math.sign(to.y - from.y) };
}

const MAX_FIXTURE_STEPS = 6;

/**
 * A tiny stand-in for the server. It is deliberately dumber than the engine — straight-line
 * paths, fixed damage, no initiative — but it produces the same protocol messages, including
 * `error` with a player-readable reason, which is what the HUD is wired against.
 */
export function connectFixture(handlers: TransportHandlers): Transport {
  const view: ViewState = viewFromSnapshot(fixtureSnapshot());
  let turn = 0;
  let hits = 0;
  let closed = false;
  const timers: ReturnType<typeof setTimeout>[] = [];

  const emit = (message: ServerMessage): void => {
    if (!closed) handlers.onMessage(message);
  };

  const commit = (diffs: Diff[]): void => {
    applyDiffsToView(view, diffs);
    turn += 1;
    emit({ type: 'diffs', room: DEFAULT_ROOM, turn, diffs, hash: `fixture-hash-${turn}` });
  };

  const reject = (reason: string): void => {
    emit({ type: 'error', room: DEFAULT_ROOM, turn, reason });
  };

  const resolveMove = (intent: Extract<Intent, { kind: 'move' }>): void => {
    const actor = view.entities[intent.entity];
    if (!actor) return reject(`no such entity: ${intent.entity}`);
    if (!isAlive(actor)) return reject(`${actor.name} is down`);
    if (!view.map) return reject('no map loaded');
    if (!isWalkable(view.map, intent.to)) return reject('that tile is not walkable');
    if (tileDistance(actor.tile, intent.to) > MAX_FIXTURE_STEPS) {
      return reject(`too far: ${actor.name} can move ${MAX_FIXTURE_STEPS} tiles this turn`);
    }
    const path: Tile[] = [];
    let at = actor.tile;
    while (at.x !== intent.to.x || at.y !== intent.to.y) {
      at = stepToward(at, intent.to);
      if (!isWalkable(view.map, at)) return reject('no path: something is in the way');
      path.push(at);
    }
    if (path.length === 0) return reject(`${actor.name} is already there`);
    commit([{ type: 'EntityMoved', entity: actor.id, from: actor.tile, to: intent.to, path }]);
  };

  const resolveAttack = (intent: Extract<Intent, { kind: 'attack' }>): void => {
    const attacker = view.entities[intent.attacker];
    const target = view.entities[intent.target];
    if (!attacker || !target) return reject('no such entity');
    if (!isAlive(target)) return reject(`${target.name} is already down`);
    if (tileDistance(attacker.tile, target.tile) > 1) return reject('out of reach: step closer');
    // Deterministic, so the fixture replays the same way every time (and lint forbids Math.random).
    const amount = 3 + (hits++ % 4);
    commit([
      {
        type: 'DamageApplied',
        target: target.id,
        amount,
        source: attacker.id,
        hpAfter: Math.max(0, target.hp - amount),
      },
    ]);
  };

  handlers.onStatus('fixture');
  timers.push(
    setTimeout(() => {
      emit(fixtureSnapshotMessage(turn));
      // Play the scripted turns so the animation queue has something to chew on at start-up.
      fixtureScript().forEach((diffs, i) => {
        timers.push(setTimeout(() => commit(diffs), 900 + i * 1400));
      });
    }, 0),
  );

  return {
    send(message) {
      if (closed || message.type !== 'intent') return;
      const intent = message.intent;
      if (intent.kind === 'move') resolveMove(intent);
      else if (intent.kind === 'attack') resolveAttack(intent);
      else reject('end_turn is not implemented in fixture mode');
    },
    close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      handlers.onStatus('closed');
    },
  };
}

/** Gap between replayed turns, on top of however long that turn's animations take to drain. */
export const REPLAY_GAP_MS = 400;

/**
 * Plays a recorded session back through the real render path (ALE-19): `?replay=yard-brawl`.
 *
 * It is a transport because that is all a recording is from the client's side — a server that has
 * already decided everything. Intents are ignored: you are watching, not playing. Turns are paced
 * by the caller telling us when the animation queue has drained, so a long fight cannot outrun the
 * renderer and stack two turns of diffs into one frame, which is precisely the overlap bug this
 * exists to catch.
 */
export function connectReplay(
  name: string,
  handlers: TransportHandlers & { idle(): boolean },
): Transport {
  let closed = false;
  const timers: ReturnType<typeof setTimeout>[] = [];

  handlers.onStatus(`replay ${name}`);
  void (async () => {
    const response = await fetch(`/recordings/${encodeURIComponent(name)}.jsonl`).catch(() => null);
    const session = response?.ok ? parseRecording(await response.text()) : null;
    if (closed) return;
    if (!session) {
      handlers.onStatus(`replay ${name} (not found)`);
      return;
    }
    handlers.onMessage({
      type: 'snapshot',
      room: DEFAULT_ROOM,
      turn: 0,
      snapshot: session.snapshot,
      hash: '',
    });
    let index = 0;
    const step = (): void => {
      if (closed || index >= session.turns.length) return;
      // Wait for the previous turn to finish drawing before sending the next one.
      if (!handlers.idle()) {
        timers.push(setTimeout(step, 60));
        return;
      }
      const next = session.turns[index++];
      if (next) {
        handlers.onMessage({
          type: 'diffs',
          room: DEFAULT_ROOM,
          turn: next.turn,
          diffs: next.diffs,
          hash: next.hash,
        });
      }
      timers.push(setTimeout(step, REPLAY_GAP_MS));
    };
    timers.push(setTimeout(step, REPLAY_GAP_MS));
  })();

  return {
    send() {
      // A recording is not interactive. Dropping intents is the honest behaviour.
    },
    close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      handlers.onStatus('closed');
    },
  };
}

/**
 * Asks the server whether a game master is behind it (ALE-39). `/healthz` is a plain GET the vite
 * dev server already proxies, so this needs no protocol change and no socket: the panel wants the
 * answer before the first click, and the socket may still be connecting.
 *
 * Every failure is the same answer — "nothing to ask" — because from the player's seat an absent
 * server and an unreachable one both mean no model ran.
 */
export async function fetchGmHealth(): Promise<GmAvailability> {
  try {
    const response = await fetch('/healthz');
    if (!response.ok) return NO_GM;
    const gm = ((await response.json()) as { gm?: Partial<GmAvailability> }).gm;
    return {
      server: true,
      configured: gm?.configured === true,
      reachable: gm?.reachable === true,
      model: gm?.model ?? null,
      narrateModel: gm?.narrateModel ?? null,
    };
  } catch {
    return NO_GM;
  }
}

/** `?fixture=1` (or `#fixture`) picks the offline stand-in. */
export function useFixtureMode(search: string, hash = ''): boolean {
  return new URLSearchParams(search).get('fixture') === '1' || hash.includes('fixture');
}
