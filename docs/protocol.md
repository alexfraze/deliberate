# WebSocket turn protocol

Owner: ALE-11. This page is the human-readable half of `packages/protocol/src/index.ts`; the code
is authoritative. The server side lives in `packages/server/src/{frames,room,app}.ts`.

Transport: one WebSocket per client at `/ws`. Every frame is one JSON object with a `type` field.
Every message carries `room` (the MVP has one room, `"main"`, the `DEFAULT_ROOM` constant) so
multiplayer does not change the shapes. Text frames only; binary frames are decoded as UTF-8 and
must still be JSON.

`GET /healthz` answers `{ ok, engine, protocol, room, turn, recording }` and needs no socket.
`recording` is the JSONL file this session is being written to, or `null` when recording is off.

## The turn number

The room owns a monotonic turn counter, starting at `0`. It is the protocol's optimistic-concurrency
token, not a game-clock: it increments by one **per committed intent**, so a rejected intent leaves
it alone. The in-world clock and the initiative round live in the snapshot (`world.clock`,
`initiative.round`) and are the engine's business.

A client composes an intent against the turn it last saw and sends that number back. The server
commits only if it matches.

## Client → server

| type     | fields                   | when                                         |
| -------- | ------------------------ | -------------------------------------------- |
| `join`   | `room`, `protocol`       | First frame. Server replies with `snapshot`. |
| `intent` | `room`, `turn`, `intent` | The player commits an action for `turn`.     |

`intent` is one of `move { entity, to }`, `attack { attacker, target, ability }`,
`end_turn { entity }` in M0.

`protocol` must equal `PROTOCOL_VERSION`; a mismatch is refused with an `error` and the socket does
not join. A socket must `join` before it may send an `intent`.

## Server → client

| type        | fields                             | when                                                        |
| ----------- | ---------------------------------- | ----------------------------------------------------------- |
| `snapshot`  | `room`, `turn`, `snapshot`, `hash` | Reply to `join`, and the resync after a stale `intent`.     |
| `preview`   | `room`, `turn`, `text`, `diffs`    | Speculative resolution before GO. Unsent in M0.             |
| `diffs`     | `room`, `turn`, `diffs`, `hash`    | Committed mutations. The client animates these in order.    |
| `narration` | `room`, `turn`, `chunk`, `done`    | Streamed prose. Unsent in M0.                               |
| `error`     | `room`, `turn`, `reason`           | Rejected intent or protocol error; `reason` is user-facing. |

- `diffs` carries the turn number **after** the commit (`turn + 1`) and the state hash after the
  engine applied them. It is broadcast to every joined socket, not only the sender.
- `error` is sent only to the socket that caused it. `turn` is the room's current turn, so the
  client always learns where the room is; `null` is reserved for errors raised before a room is
  known and is unused in M0.
- `reason` is always something a player can read on screen. For a rejected intent it is the
  engine's `Verdict.reason` verbatim ("(3, 4) cannot be walked on.", "Training Dummy A is 30 ft
  away; a Longsword reaches 5 ft."); for a protocol failure the server writes its own.

## Sequence (M0)

```
client                      server
  |-- join ------------------>|
  |<-- snapshot(turn=0) ------|   full state + hash; socket is now a member
  |-- intent(turn=0, move) -->|   engine.apply(intent)
  |<-- diffs(turn=1) ---------|   ok: diffs + new hash, broadcast; a TurnCommit fires
  |-- intent(turn=1, attack)->|
  |<-- error(turn=1) ---------|   rejected: "…is 30 ft away…"; state and turn unchanged
  |-- intent(turn=1, move) -->|
  |<-- diffs(turn=2) ---------|
```

Stale intent:

```
  |-- intent(turn=0, move) -->|   the room is on turn 2
  |<-- error(turn=2) ---------|   "That action was composed for turn 0; the room is on turn 2…"
  |<-- snapshot(turn=2) ------|   resync, so the client can recompose; the engine was never called
```

## Rules the server enforces

Nothing off the wire is trusted. `parseClientFrame` validates a frame completely before the room or
the engine sees it; the room then checks the room id, membership and the turn; only then does the
engine see the intent, and the engine validates legality itself. Each row below is an `error`.

| Condition                                      | Reason the client gets                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Frame is not JSON, or not a JSON object        | "That frame was not valid JSON." / "…must be a JSON object."                    |
| Missing or non-string `room`                   | "That frame is missing a room id."                                              |
| `type` is not `join` or `intent`               | "Unknown frame type …"                                                          |
| `join` with the wrong `protocol`               | "This server speaks protocol N; your client said M…"                            |
| `intent` with a missing or non-integer `turn`  | "An intent must carry the turn number it was composed against."                 |
| `intent` whose `intent` is not a shaped M0 one | "That is not an action this server understands (move, attack, end_turn)."       |
| `room` is not this server's room               | "There is no room called "x" on this server."                                   |
| `intent` from a socket that never joined       | "Join the room before sending an action."                                       |
| `turn` ≠ the room's turn                       | "That action was composed for turn N; the room is on turn M…" plus a `snapshot` |
| The engine rejects the intent                  | `Verdict.reason`, unchanged                                                     |

An `error` never advances the turn and never mutates state. A malformed frame does not close the
socket; the next well-formed frame is handled normally.

## The room

`createRoom({ engine, id })` in `packages/server/src/room.ts` holds the `Engine`, the turn counter,
and the set of joined sockets. It performs no I/O and never mutates a snapshot — the engine is the
only thing that does.

`buildApp({ engine?, seed?, room?, logger? })` takes an injected `Engine` (tests pass a fake) and
otherwise builds the real one over the M0 fixture snapshot. The room is reachable as `app.room`.

### Recorder hook

`room.onTurn(listener)` fires once per **committed** turn — never for a rejection — and returns an
unsubscribe function. The listener receives:

```ts
interface TurnCommit {
  room: RoomId;
  turn: number; // the turn the intent was composed against; the room is on turn + 1 now
  intent: Intent;
  verdict: Verdict;
  diffs: Diff[];
  hashBefore: StateHash;
  hashAfter: StateHash;
}
```

The field names line up with `RecordedTurn`, so ALE-30's Recorder can append a line without the
room knowing anything about files. Listeners must not throw; the room does not catch.

`buildApp({ recordings: '<dir>' })` is what wires it up (ALE-13): one JSONL file per run of the
server, closed with the app. The default is `null` — no recording — so unit tests and CI write
nothing; `packages/server/src/index.ts` passes `recordings` (override with `RECORDINGS_DIR`, or
set it empty to turn recording off).

## Answers to the questions this page used to ask

- **Stale `turn`:** `error` _and_ a fresh `snapshot` to that sender. Rejecting alone would make the
  client reconnect to recover; resending the snapshot closes the loop in one round trip.
- **Unprompted `diffs` for NPC turns (M1):** yes, the shape allows it, and the room already
  broadcasts committed diffs to every member rather than replying only to the sender. When a GM or
  an NPC brain commits a turn, the same `diffs` frame goes out with no client intent behind it.
- **Reconnect:** `join` again and receive a fresh `snapshot`. No resume, no replay of missed diffs
  in M0. A dropped socket is removed from the broadcast set on close.

## Not yet spoken

`preview` and `narration` are in the protocol but never sent in M0: there is no model in the loop
until M1. Clients should tolerate them.
