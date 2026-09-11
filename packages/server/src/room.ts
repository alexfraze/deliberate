import type { Engine } from '@deliberate/engine';
import {
  DEFAULT_ROOM,
  type ClientMessage,
  type Diff,
  type GmToolCall,
  type Intent,
  type GoMessage,
  type IntentMessage,
  type PreviewRequestMessage,
  type RoomId,
  type ServerMessage,
  type SnapshotMessage,
  type StateHash,
  type ToolCallRecord,
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

/**
 * Announced once per mutation the room put through the engine. Field names line up with
 * `RecordedTurn` (ALE-30), and the recorder writes one line per commit — including the GM's, so a
 * recorded session replays by re-applying intents in the order they actually hit the engine.
 */
export interface TurnCommit {
  room: RoomId;
  /** The turn the intent was composed against; the room is on `turn + 1` once this fires. */
  turn: number;
  intent: Intent;
  verdict: Verdict;
  diffs: Diff[];
  hashBefore: StateHash;
  hashAfter: StateHash;
  /**
   * Who asked. `player` commits advance the turn counter; `gm` commits do not — one GO is one
   * player turn however many tool calls the game master made inside it (ALE-32).
   */
  source: 'player' | 'gm';
  /** The GM tool call this mutation came from, with the engine's verdict. Empty for the player. */
  toolCalls: ToolCallRecord[];
}

export type TurnListener = (commit: TurnCommit) => void;

/** Handles the GM loop's frames. Installed by `buildApp`; absent means the loop is not running. */
export type GmFrameHandler = (
  socket: RoomSocket,
  message: PreviewRequestMessage | GoMessage,
) => void;

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
  /** Sends one frame to every member. The GM loop's preview, narration and diffs go out here. */
  broadcast(message: ServerMessage): void;
  /**
   * Puts one player intent through the engine: validate, apply, broadcast the diffs, advance the
   * turn, announce. This is what an `intent` frame and a `go` frame both end up calling, so there
   * is one commit path rather than two that could drift.
   */
  commit(intent: Intent): Verdict;
  /**
   * Puts one GM tool call's intent through the engine. Identical to `commit` except that the turn
   * counter does not move and the call travels into the recording beside its verdict. A rejection
   * is still announced — the recording is the evidence a proposed change was refused — and, by the
   * engine's contract, left the world untouched.
   */
  commitGmCall(intent: Intent, call: GmToolCall): Verdict;
  /** Handles one validated frame. Replies go to `socket`; committed diffs go to every member. */
  handle(socket: RoomSocket, message: ClientMessage): void;
  /** Reports a frame that never parsed (bad JSON, unknown type) back to its sender. */
  refuse(socket: RoomSocket, reason: string): void;
  leave(socket: RoomSocket): void;
  /** Installs the handler for `preview_request` and `go`. Called once, by `buildApp`. */
  setGmFrames(handler: GmFrameHandler): void;
  /** Subscribe to committed turns. Returns an unsubscribe function. */
  onTurn(listener: TurnListener): () => void;
}

export function createRoom(options: RoomOptions): Room {
  const id = options.id ?? DEFAULT_ROOM;
  const { engine } = options;
  const members = new Set<RoomSocket>();
  const listeners = new Set<TurnListener>();
  let turn = 0;
  let gmFrames: GmFrameHandler | null = null;

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

  const broadcast = (message: ServerMessage): void => {
    const text = JSON.stringify(message);
    for (const member of members) member.send(text);
  };

  const announce = (event: TurnCommit): void => {
    for (const listener of [...listeners]) listener(event);
  };

  /** The one place an intent reaches the engine. `advance` is what separates a GO from a GM call. */
  const put = (intent: Intent, source: 'player' | 'gm', call?: GmToolCall): Verdict => {
    const hashBefore = engine.hash();
    const verdict = engine.apply(intent);
    const resolved = turn;
    if (verdict.ok && source === 'player') turn += 1;
    const hashAfter = engine.hash();
    if (verdict.ok) {
      broadcast({ type: 'diffs', room: id, turn, diffs: verdict.diff, hash: hashAfter });
    }
    // A refused player action is not a turn: the player is told why and composes another. A refused
    // GM call *is* announced, because the recording has to show that the world said no to the
    // model — that refusal is the evidence the verified ledger (ALE-15) is built from.
    if (!verdict.ok && source === 'player') return verdict;
    announce({
      room: id,
      turn: resolved,
      intent,
      verdict,
      diffs: verdict.diff,
      hashBefore,
      hashAfter,
      source,
      toolCalls: call ? [{ name: call.name, args: call.args, verdict }] : [],
    });
    return verdict;
  };

  const commitFrame = (socket: RoomSocket, message: IntentMessage): void => {
    if (message.turn !== turn) {
      refuse(
        socket,
        `That action was composed for turn ${message.turn}; the room is on turn ${turn}. Here is the current state.`,
      );
      send(socket, snapshotMessage());
      return;
    }
    const verdict = put(message.intent, 'player');
    if (!verdict.ok) refuse(socket, verdict.reason);
  };

  return {
    id,
    engine,
    turn: () => turn,
    size: () => members.size,
    snapshotMessage,
    broadcast,
    commit: (intent) => put(intent, 'player'),
    commitGmCall: (intent, call) => put(intent, 'gm', call),
    refuse,
    leave: (socket) => {
      members.delete(socket);
    },
    setGmFrames: (handler) => {
      gmFrames = handler;
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
      if (message.type === 'intent') {
        commitFrame(socket, message);
        return;
      }
      // `preview_request` and `go` are the GM loop's frames (ALE-32). The room knows nothing about
      // the game master; `buildApp` installs a handler, and without one the loop is simply off.
      if (!gmFrames) {
        refuse(socket, 'No game master is running on this server.');
        return;
      }
      gmFrames(socket, message);
    },
  };
}
