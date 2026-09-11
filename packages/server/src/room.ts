import type { Engine } from '@deliberate/engine';
import {
  DEFAULT_ROOM,
  type ClientMessage,
  type Diff,
  type Intent,
  type IntentMessage,
  type RoomId,
  type ServerMessage,
  type SnapshotMessage,
  type StateHash,
  type Verdict,
} from '@deliberate/protocol';

/**
 * The single in-memory room (ALE-11). It owns an `Engine`, the turn counter, and the sockets that
 * have joined; it never mutates a snapshot itself and never does I/O. One frame in, one or more
 * frames out:
 *
 *   join   -> `snapshot` to the joiner
 *   intent -> `diffs` to everyone (turn + 1, new hash) or `error` to the sender (turn unchanged)
 *
 * Every committed turn is announced to `onTurn` listeners so the recorder (ALE-30) can append a
 * line without the room knowing anything about files. Listeners must not throw.
 */

/** The slice of a WebSocket the room needs. `ws`'s WebSocket satisfies it, so tests can fake it. */
export interface RoomSocket {
  send(data: string): void;
}

/** Announced once per committed turn. Field names line up with `RecordedTurn` (ALE-30). */
export interface TurnCommit {
  room: RoomId;
  /** The turn the intent was composed against; the room is on `turn + 1` once this fires. */
  turn: number;
  intent: Intent;
  verdict: Verdict;
  diffs: Diff[];
  hashBefore: StateHash;
  hashAfter: StateHash;
}

export type TurnListener = (commit: TurnCommit) => void;

export interface RoomOptions {
  engine: Engine;
  id?: RoomId;
}

export interface Room {
  readonly id: RoomId;
  readonly engine: Engine;
  /** The turn the room is accepting intents for. Starts at 0, increments per committed turn. */
  turn(): number;
  /** Number of sockets that have joined. */
  size(): number;
  /** The current authoritative state, as the frame sent in reply to `join`. */
  snapshotMessage(): SnapshotMessage;
  /** Handles one validated frame. Replies go to `socket`; committed diffs go to every member. */
  handle(socket: RoomSocket, message: ClientMessage): void;
  /** Reports a frame that never parsed (bad JSON, unknown type) back to its sender. */
  refuse(socket: RoomSocket, reason: string): void;
  leave(socket: RoomSocket): void;
  /** Subscribe to committed turns. Returns an unsubscribe function. */
  onTurn(listener: TurnListener): () => void;
}

export function createRoom(options: RoomOptions): Room {
  const id = options.id ?? DEFAULT_ROOM;
  const { engine } = options;
  const members = new Set<RoomSocket>();
  const listeners = new Set<TurnListener>();
  let turn = 0;

  const send = (socket: RoomSocket, message: ServerMessage): void => {
    socket.send(JSON.stringify(message));
  };

  const refuse = (socket: RoomSocket, reason: string): void => {
    send(socket, { type: 'error', room: id, turn, reason });
  };

  const snapshotMessage = (): SnapshotMessage => ({
    type: 'snapshot',
    room: id,
    turn,
    snapshot: engine.snapshot(),
    hash: engine.hash(),
  });

  const commit = (socket: RoomSocket, message: IntentMessage): void => {
    if (message.turn !== turn) {
      refuse(
        socket,
        `That action was composed for turn ${message.turn}; the room is on turn ${turn}. Here is the current state.`,
      );
      send(socket, snapshotMessage());
      return;
    }

    const hashBefore = engine.hash();
    const verdict = engine.apply(message.intent);
    if (!verdict.ok) {
      refuse(socket, verdict.reason);
      return;
    }

    const resolved = turn;
    turn += 1;
    const hashAfter = engine.hash();
    const diffs: ServerMessage = {
      type: 'diffs',
      room: id,
      turn,
      diffs: verdict.diff,
      hash: hashAfter,
    };
    const text = JSON.stringify(diffs);
    for (const member of members) member.send(text);

    const event: TurnCommit = {
      room: id,
      turn: resolved,
      intent: message.intent,
      verdict,
      diffs: verdict.diff,
      hashBefore,
      hashAfter,
    };
    for (const listener of [...listeners]) listener(event);
  };

  return {
    id,
    engine,
    turn: () => turn,
    size: () => members.size,
    snapshotMessage,
    refuse,
    leave: (socket) => {
      members.delete(socket);
    },
    onTurn: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    handle(socket, message) {
      if (message.room !== id) {
        refuse(socket, `There is no room called "${message.room}" on this server.`);
        return;
      }
      if (message.type === 'join') {
        members.add(socket);
        send(socket, snapshotMessage());
        return;
      }
      if (!members.has(socket)) {
        refuse(socket, 'Join the room before sending an action.');
        return;
      }
      commit(socket, message);
    },
  };
}
