# The replay-based regression suite (ALE-21)

A bank of recorded sessions, replayed against the engine on every push. It is the concrete form of
the blueprint's fourth pillar — _prompt and model changes are judged on replayed sessions_ — and of
the determinism rule in CLAUDE.md: same seed and same intents must replay to identical state hashes.

```sh
pnpm bank                                        # the whole bank; needs the engine and nothing else
pnpm replay recordings/bank/m1-acceptance.jsonl  # one entry
pnpm --filter @deliberate/server bank:write      # regenerate the generated entries + the manifest
```

The bank also runs as a test (`packages/server/src/bank/bank.test.ts`), so it is inside `pnpm check`
— the required CI job. Nothing in it touches the model, the network, Python or a browser, which is
what makes that affordable.

## What is in it

`recordings/bank/` is the bank: one JSONL recording per session, plus `bank.json`, which names each
session, what counts as its objective, and the numbers it produced.

| session                | source | turns | what it is there to catch                                                 |
| ---------------------- | ------ | ----- | ------------------------------------------------------------------------- |
| `m1-acceptance`        | live   | 56    | a real `claude-opus-5` playthrough (ALE-17); the only model-written entry |
| `m0-yard-skirmish`     | engine | 6     | a death: damage, the `dead` condition, the clock, a corpse refusing       |
| `gatehouse-refusals`   | engine | 9     | every mutation kind refused; a whole session that changes nothing         |
| `gatehouse-initiative` | engine | 9     | four combatants, initiative wrapping twice into round three               |
| `gatehouse-gm-tools`   | engine | 12    | all nine mutation tools through `executeGmTool`, `spawn` included         |

The live entry cost money and half an hour and is never regenerated: its bytes are evidence. The
engine-driven four are a pure function of the engine and the seeds, written by
`packages/server/src/bank/generate.ts`. The test regenerates them and holds the result to the
committed bytes, so a rules change shows up as a diff rather than as a silent rewrite.

`bank.json` is derived, never hand-edited — a hand-typed hash is a hash nobody checked.

## What is checked

Per session, in `packages/engine/src/recorder/bank.ts`:

1. **Replay.** A fresh engine re-applies the recorded intents and must reach every recorded hash.
   The hard gate.
2. **The final hash**, against the manifest. Replay only proves a recording is _self-consistent_; a
   regenerated recording can be perfectly self-consistent and describe a different world. The
   manifest is the checked-in ground truth that catches that.
3. **The tool contract.** Every recorded GM tool call is re-validated against today's
   `contracts/gm-tools.json` and re-mapped through `toIntent`, which must reproduce the intent the
   engine was actually given. Replay cannot see this: it only ever looks at `intent`. This is where
   a renamed argument or a dropped tool — a change to what the model is _sent_ — fails the bank.
4. **The metrics** the issue asks prompt and model changes to be compared on: turns, verdict
   rejection rate, turns to objective, and tokens and latency where the recording carries them.
   Recordings written before the cost meters (ALE-24) carry zeros; zeros are reported, not gated.

## Proving it can fail

A regression suite that only ever passes is worthless, so `bank.test.ts` breaks the bank four ways
and requires each to turn it red: a drifting engine, a session that replays but describes a
different world, a moved metric, and a tool call that no longer fits the contract.

That is the permanent form. Two one-off demonstrations were run against the real bank for ALE-21
and then reverted:

| perturbation                                              | result                                                                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| longsword `d8` → `d10` in `rules/weapons.ts`              | `FAIL bank: 3/5` — two sessions diverge at the first landed hit, and the generated recordings stop reproducing byte for byte  |
| `say.npc_id` → `say.speaker` in `contracts/gm-tools.json` | `FAIL bank: 3/5` — 17 recorded `say` calls, 15 of them in the live M1 playthrough, no longer fit the schema the model is sent |

The second is the issue's "deliberately broken prompt": the tool schemas are part of the request,
nothing about the recordings changed, every session still replays — and the bank is red anyway.

## Adding an entry

Prefer a deterministic one: add a `Scenario` to `generate.ts`, run `bank:write`, read the diff,
commit. A live entry is worth it only when it shows something the engine cannot be scripted into —
a real model's tool sequence — and it is added by committing the recording and a manifest row.

## One thing the bank found

`RecordingHeader` carried a snapshot and a seed but not the engine's `templates` table. `spawn`
reads that table, so any session in which the game master spawned did not replay, and a rejected
spawn did not either, because the rejection reason names the templates that were loaded. The header
now carries them (optional and omitted when empty, so older recordings are unaffected), the server
passes the scene's templates to the recorder, and `gatehouse-gm-tools` is the entry that keeps it
honest.
