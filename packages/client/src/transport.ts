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

import { fixtureScript, fixtureSnapshot, fixtureSnapshotMessage } from './fixtures/index.js';
import { isWalkable, tileDistance } from './grid.js';
import { encodeClientMessage, parseServerMessage } from './messages.js';
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

/** `?fixture=1` (or `#fixture`) picks the offline stand-in. */
export function useFixtureMode(search: string, hash = ''): boolean {
  return new URLSearchParams(search).get('fixture') === '1' || hash.includes('fixture');
}
