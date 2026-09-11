# WebSocket turn protocol

Owner: ALE-11. This page is the human-readable half of `packages/protocol/src/index.ts`; the code
is authoritative. TODO(ALE-11): fill in the sequence, error reasons, and reconnect rules.

Transport: one WebSocket per client at `/ws`. Every frame is one JSON object with a `type` field.
Every message carries `room` (the MVP has one room, `"main"`) so multiplayer does not change the
shapes.

## Client → server

| type     | fields                   | when                                         |
| -------- | ------------------------ | -------------------------------------------- |
| `join`   | `room`, `protocol`       | First frame. Server replies with `snapshot`. |
| `intent` | `room`, `turn`, `intent` | The player commits an action for `turn`.     |

`intent` is one of `move { entity, to }`, `attack { attacker, target, ability }`,
`end_turn { entity }` in M0.

## Server → client

| type        | fields                             | when                                                        |
| ----------- | ---------------------------------- | ----------------------------------------------------------- |
| `snapshot`  | `room`, `turn`, `snapshot`, `hash` | Reply to `join`. Full authoritative state.                  |
| `preview`   | `room`, `turn`, `text`, `diffs`    | Speculative resolution before GO. Empty in M0.              |
| `diffs`     | `room`, `turn`, `diffs`, `hash`    | Committed mutations. The client animates these in order.    |
| `narration` | `room`, `turn`, `chunk`, `done`    | Streamed prose. Unused in M0.                               |
| `error`     | `room`, `turn`, `reason`           | Rejected intent or protocol error; `reason` is user-facing. |

## Sequence (M0)

```
client                      server
  |-- join ------------------>|
  |<-- snapshot(turn=0) ------|
  |-- intent(turn=0, move) -->|   engine.apply(intent)
  |<-- diffs(turn=1) ---------|   ok: diffs + new hash, recorder appends a line
  |-- intent(turn=1, attack)->|
  |<-- error(turn=1) ---------|   rejected: "target out of range"; state and turn unchanged
```

## Open questions for ALE-11

- Stale `turn` handling: reject with `error`, or resend `snapshot`?
- Does the server push `diffs` for NPC turns unprompted (needed by M1)? The shape allows it.
- Reconnect: `join` again and receive a fresh `snapshot`; no resume in M0.
