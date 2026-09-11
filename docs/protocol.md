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

| type              | fields                            | when                                                  |
| ----------------- | --------------------------------- | ----------------------------------------------------- |
| `join`            | `room`, `protocol`                | First frame. Server replies with `snapshot`.          |
| `intent`          | `room`, `turn`, `intent`          | The player commits an action for `turn`, immediately. |
| `preview_request` | `room`, `turn`, `intent`, `text?` | Ask for a speculative turn (ALE-32). Commits nothing. |
| `go`              | `room`, `turn`                    | Commit the last preview.                              |

`intent` is one of `move { entity, to }`, `attack { attacker, target, ability }`,
`end_turn { entity }`. The GM's other intent kinds (`cast`, `say`, `set_disposition`, `spawn`,
`set_flag`, `advance_quest`, ALE-31) do not travel on this socket: they arrive as tool calls on
`POST /gm/tool`, where the engine validates them against `contracts/gm-tools.json`.

`preview_request.intent` may be `null` — "what does the world do if I do nothing?" — and `text` is
free player speech, capped at 2000 characters. It reaches the game master as quoted data, never as
instruction (ALE-33).

`protocol` must equal `PROTOCOL_VERSION`; a mismatch is refused with an `error` and the socket does
not join. A socket must `join` before it may send an `intent`.

## Server → client

| type        | fields                             | when                                                        |
| ----------- | ---------------------------------- | ----------------------------------------------------------- |
| `snapshot`  | `room`, `turn`, `snapshot`, `hash` | Reply to `join`, and the resync after a stale `intent`.     |
| `preview`   | `room`, `turn`, `text`, `diffs`    | Speculative resolution before GO. Nothing in it happened.   |
| `diffs`     | `room`, `turn`, `diffs`, `hash`    | Committed mutations. The client animates these in order.    |
| `narration` | `room`, `turn`, `chunk`, `done`    | Streamed prose after a GO. `done` closes the stream.        |
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
| `type` is not a known frame type               | "Unknown frame type …"                                                          |
| `join` with the wrong `protocol`               | "This server speaks protocol N; your client said M…"                            |
| `intent` with a missing or non-integer `turn`  | "An intent must carry the turn number it was composed against."                 |
| `intent` whose `intent` is not a shaped M0 one | "That is not an action this server understands (move, attack, end_turn)."       |
| `room` is not this server's room               | "There is no room called "x" on this server."                                   |
| `intent` from a socket that never joined       | "Join the room before sending an action."                                       |
| `turn` ≠ the room's turn                       | "That action was composed for turn N; the room is on turn M…" plus a `snapshot` |
| The engine rejects the intent                  | `Verdict.reason`, unchanged                                                     |

An `error` never advances the turn and never mutates state. A malformed frame does not close the
socket; the next well-formed frame is handled normally.

## Preview → GO (ALE-32)

The M1 loop. A `preview_request` is answered by the game master acting on a **clone** of the
engine, so the real engine's state hash is byte-identical before and after; a `go` re-validates
what was previewed against the real engine and applies it.

```
client                              server
  |-- preview_request(turn=3) ------>|  clone the engine, mint an engine_token for the clone
  |                                  |  apply the player's intent to the CLONE
  |                                  |  POST /turn to the GM, which calls back to /gm/tool
  |<-- preview(turn=3) --------------|  text + diffs that have NOT happened; the clone is discarded
  |-- preview_request(turn=3) ------>|  changed your mind: a fresh clone, the last preview replaces
  |<-- preview(turn=3) --------------|
  |-- go(turn=3) ------------------->|  re-validate on the REAL engine, apply, resolve, narrate
  |<-- diffs(turn=4) ----------------|  the player's committed action
  |<-- diffs(turn=4) ----------------|  each GM mutation, as the engine accepts it
  |<-- narration(done=false) --------|  …streamed…
  |<-- narration(done=true) ---------|
```

- Only the **last** preview is pending. Previewing again discards the one before it, and a preview
  that was never GO'd changes nothing at all.
- GO does not trust the preview's verdicts. The clone reseeds its RNG from the room's seed and the
  world may have moved, so every previewed call is put to the real engine again; the batch stops at
  the first refusal, exactly as the game master's own batches do.
- A GM mutation broadcasts `diffs` at the **current** turn: the counter moves once per player
  commit, so one GO is one turn however many tool calls the game master made inside it.
- With no game master configured (no `GM_SERVICE_URL`), the loop still runs: the preview shows the
  engine's own resolution of the staged intent and GO commits it.

## `POST /gm/tool`

The only door into the engine for the game master (decision 1 of `docs/m1-swarm.md`). Request
`{session, turn, engine_token, call_id, tool, input}`, response `{ok, kind, reason, diff, result,
state_hash}`; the full contract is in `docs/gm-service.md`.

`engine_token` names which engine the call acts on: `live` (or absent) is the real one, and a
preview's token names that preview's clone. A token the server never minted is refused rather than
falling back to the live engine, and **while a preview is running the live engine is closed to
mutations entirely** — queries stay free. The clone is the isolation; the seal is the assertion
that it held even if the service echoed the wrong token.

## The room

`createRoom({ engine, id })` in `packages/server/src/room.ts` holds the `Engine`, the turn counter,
and the set of joined sockets. It performs no I/O and never mutates a snapshot — the engine is the
only thing that does.

`buildApp({ engine?, seed?, room?, scene?, gm?, logger? })` takes an injected `Engine` (tests pass a
fake) and otherwise builds the real one over the chosen scene: `gatehouse` (the M1 scene from
`content/npcs`, the default) or `fixture` (the M0 training yard, which the acceptance run plays).
`DELIBERATE_SCENE=fixture` selects it at the command line. The room is reachable as `app.room` and
the turn loop as `app.gm`.

### Recorder hook

`room.onTurn(listener)` fires once per mutation the room put through the engine and returns an
unsubscribe function. A refused _player_ action is not a turn and does not fire; a refused _GM_
call does, because the recording has to show that the world said no to the model. The listener
receives:

```ts
interface TurnCommit {
  room: RoomId;
  turn: number; // the turn the intent was composed against; the room is on turn + 1 now
  intent: Intent;
  verdict: Verdict;
  diffs: Diff[];
  hashBefore: StateHash;
  hashAfter: StateHash;
  source: 'player' | 'gm'; // only a player commit advances the turn counter
  toolCalls: ToolCallRecord[]; // the GM tool call behind this mutation; empty for the player
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

Narration is delivered over one `/turn` response and then chunked out; server-sent events between
Node and Python are the obvious next step and are deliberately not in M1. `ToolCallRecord.args`
carries the call as the model produced it, which is what the verified ledger (ALE-15) quotes.
