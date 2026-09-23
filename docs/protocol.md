# WebSocket turn protocol

Owner: ALE-11. This page is the human-readable half of `packages/protocol/src/index.ts`; the code
is authoritative. The server side lives in `packages/server/src/{frames,room,app}.ts`.

Transport: one WebSocket per client at `/ws`. Every frame is one JSON object with a `type` field.
Every message carries `room` (the MVP has one room, `"main"`, the `DEFAULT_ROOM` constant) so
multiplayer does not change the shapes. Text frames only; binary frames are decoded as UTF-8 and
must still be JSON.

`GET /healthz` answers
`{ ok, engine, protocol, room, turn, recording, cache, speculation, meters, save, gm }`
and needs no socket. `recording` is the JSONL file this session is being written to, or `null` when
recording is off; `save` is the file `POST /save` writes, or `null` when saving is off.
`speculation` is `{ turn, spent, dropped, budget, usd, usdBudget }` — this turn's speculative
preview allowance and what it has cost (ALE-40). `gm` is
`{ configured, reachable, model, narrateModel }` — whether `GM_SERVICE_URL` is set, whether the
service answered its own `/healthz`, and which models it runs. The client reads it so it can say on
screen whether a model is in the loop at all (ALE-39); `configured: false` means no game master
runs on either path, and preview is the engine's own resolution.

## The turn number

The room owns a monotonic turn counter, starting at `0`. It is the protocol's optimistic-concurrency
token, not a game-clock: it increments by one **per committed intent**, so a rejected intent leaves
it alone. The in-world clock and the initiative round live in the snapshot (`world.clock`,
`initiative.round`) and are the engine's business.

A client composes an intent against the turn it last saw and sends that number back. The server
commits only if it matches.

## Client → server

| type              | fields                            | when                                                         |
| ----------------- | --------------------------------- | ------------------------------------------------------------ |
| `join`            | `room`, `protocol`                | First frame. Server replies with `snapshot`.                 |
| `intent`          | `room`, `turn`, `intent`          | The player commits an action for `turn`, immediately.        |
| `preview_request` | `room`, `turn`, `intent`, `text?` | Ask for a speculative turn (ALE-32). Commits nothing.        |
| `go`              | `room`, `turn`                    | Commit the last preview.                                     |
| `speculate`       | `room`, `turn`, `intent`          | Warm the preview cache for an action being hovered (ALE-40). |

`intent` is one of `move { entity, to }`, `traverse { entity, to }`,
`attack { attacker, target, ability }`, `cast { caster, spell, target }`,
`say { speaker, text, to }`, `end_turn { entity }`, `pass_time { entity }` — the things a player
does. The four **world-authoring** intent kinds (`set_disposition`, `spawn`, `set_flag`,
`advance_quest`, ALE-31) do not travel on this socket: they arrive as tool calls on
`POST /gm/tool`, where the engine validates them against `contracts/gm-tools.json`.

`pass_time` (ALE-41) is the out-of-combat companion to `end_turn`, and the two are strictly
complementary: `end_turn` needs an encounter and is refused without one — _"No encounter is
running; there is no turn to end."_ — while `pass_time` needs there not to be one. It moves the
world clock on by a round and changes nothing else; what makes it interesting is what the server
does **after** it commits, which is give the world an [ambient turn](gm-service.md#the-ambient-world-turn-ale-41).
It is a player verb and not a game master tool, so nothing but a person can decide to spend time.

`traverse` (ALE-43) walks off one map and onto another through an exit the destination map carries
a matching entrance for. `to` names the map to leave for, or is `null` to take the only exit on the
tile the entity is standing on. It is deliberately not `move` with a map argument — there is no
path between two grids — and it is validated the same way a door is: the exit under your feet, the
far side loaded, its entrance walkable and empty, your turn if there is one. It emits
`EntityTraversed`, which carries both ends of the crossing so a client can swap the board it draws
rather than sliding a capsule across coordinates that now mean somewhere else.

`author_map` (ALE-44) is the game master's only way to make terrain, and it is a tool rather than a
player verb. It writes a location **beyond a frontier** — a `MapFrontier`, an undefined edge an
existing map already carries — and the engine turns that edge into ALE-43's pair of exits itself,
so the two ends of a link cannot disagree. Terrain only: who stands in the new place is `spawn`,
which is already template-validated. It is refused, with a reason a player could read, when the
terrain does not decode to `width * height` cells, when an exit, frontier or objective cannot be
walked to from the entrance by the engine's own `path()`, when any floor is walled off from the
entrance, when the map id is taken, or when it names a map or quest that does not exist. It emits
`MapAuthored`, which carries the whole `MapRecord` — cells included — so a recording replays the
new location out of its own bytes and never calls the model.

The split is about authority, not shape. The engine validates whether a `spawn` names a real
template; it has no idea who asked, by design. So the wire is where "a person at a keyboard may not
author the world" is enforced, and it is enforced by not parsing those four kinds at all.

`preview_request.intent` may be `null` — "what does the world do if I do nothing?" — and `text` is
free player speech, capped at 2000 characters. It reaches the game master as quoted data, never as
instruction (ALE-33).

`speculate` is a **hint, not a request**. It computes the same preview on the same cloned engine and
files it under the same `(state hash, intent, text)` key a `preview_request` would look up, but it
sends nothing back and stages nothing — a `go` after one still refuses, because nothing was staged.
If the player then previews that intent for real, the answer is already in memory and arrives in
about a tenth of a second instead of tens of seconds.

It carries a non-null `intent` and no `text`: a speculation is about what is under the cursor, and
there is no half-typed sentence to guess at.

**Every one of these costs a model call — and in a fight, several.** Since ALE-32 the game master
takes the NPC turns _inside_ the preview, on the clone, so one speculation in an encounter pays for
the player's staged action and every reaction to it. The server therefore caps the pointer on two
meters: a count (`MAX_SPECULATIONS_PER_TURN`, 2) and, because a count is not a sum of money, a
per-turn dollar ceiling (`MAX_SPECULATION_USD`, $0.30 — two measured out-of-combat previews, or one
costly in-combat one). The first speculation of a turn always runs, because nothing can price a call
before making it; the honest bound is **at most two, and never a second once the first cost $0.30**.
`GM_SPECULATE=off` disables it and `GM_SPECULATE_USD` moves the ceiling. It also refuses to run two
at once, refuses one while a real phase is in flight, and charges nothing for an intent the engine
refuses before the game master is asked. The client applies the same rules first and adds a dwell
timer, but the client is a browser and the server does not trust it. Anything wrong with a
`speculate` frame — stale turn, no budget left — is answered with **silence**: the player asked for
nothing, so there is nothing to refuse them, and an `error` about where their pointer is resting
would be noise on a screen that has real errors to show.

A speculation the player contradicts is cancelled rather than waited out: previews are serialised,
so a `preview_request` for a different key aborts the guess in the air instead of queueing the
player behind it. One for the _same_ key is left alone — that is the case this exists for.

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

| Condition                                     | Reason the client gets                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Frame is not JSON, or not a JSON object       | "That frame was not valid JSON." / "…must be a JSON object."                                              |
| Missing or non-string `room`                  | "That frame is missing a room id."                                                                        |
| `type` is not a known frame type              | "Unknown frame type …"                                                                                    |
| `join` with the wrong `protocol`              | "This server speaks protocol N; your client said M…"                                                      |
| `intent` with a missing or non-integer `turn` | "An intent must carry the turn number it was composed against."                                           |
| `intent` whose `intent` is not a player one   | "That is not an action this server understands (move, traverse, attack, cast, say, end_turn, pass_time)." |
| `room` is not this server's room              | "There is no room called "x" on this server."                                                             |
| `intent` from a socket that never joined      | "Join the room before sending an action."                                                                 |
| `turn` ≠ the room's turn                      | "That action was composed for turn N; the room is on turn M…" plus a `snapshot`                           |
| The engine rejects the intent                 | `Verdict.reason`, unchanged                                                                               |

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

## `POST /save` — one JSON document per session (ALE-23)

`POST /save` writes the session to `<SAVES_DIR>/<room>.json` and answers
`{ ok, path, turn, hash }`. It is a save slot, not a history: the file is replaced each time, and
the JSONL recording above is the history. Database persistence is roadmap P2 (ALE-26).

The file (`SaveFile` in `@deliberate/protocol`, version `SAVE_VERSION`) carries the snapshot, the
room's turn counter, the scene, the seed, **the RNG stream position**, and the GM's memory blocks.
The stream position is the part a snapshot cannot give you: without it a resumed session restores
the same state hash and then rolls dice the uninterrupted session had already spent, so it stops
replaying. Loading is a restart rather than a frame — `packages/server/src/index.ts` reads
`DELIBERATE_LOAD` before the app is built, because `buildApp` does no I/O — and a file whose
`save` version is not this build's is refused rather than half read.

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
