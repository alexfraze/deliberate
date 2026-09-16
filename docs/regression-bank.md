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

| session                | source | turns | what it is there to catch                                                        |
| ---------------------- | ------ | ----- | -------------------------------------------------------------------------------- |
| `m1-acceptance`        | live   | 56    | ALE-17: a drawn sword, and a game master that answered by opening the gate       |
| `yard-brawl`           | live   | 58    | ALE-25: a **death** a real model caused — two of them, and initiative wrapping   |
| `parley`               | live   | 62    | ALE-25: ten turns with no encounter at all; flags, dispositions, two quest steps |
| `m0-yard-skirmish`     | engine | 6     | a death: damage, the `dead` condition, the clock, a corpse refusing              |
| `gatehouse-refusals`   | engine | 9     | every mutation kind refused; a whole session that changes nothing                |
| `gatehouse-initiative` | engine | 9     | four combatants, initiative wrapping twice into round three                      |
| `gatehouse-gm-tools`   | engine | 12    | all nine mutation tools through `executeGmTool`, `spawn` included                |

The three live entries cost roughly $2 and half an hour each and are never regenerated: their
bytes are evidence. They are three different stories on purpose — three recordings of the same
beats would only be the first recording weighed three times, and a regression that shows up only
in combat, or only in dialogue, needs somewhere to fail. `SCRIPTS` in
`packages/server/src/acceptance.test.ts` is what they were played from; `DELIBERATE_SCRIPT` picks
one and `DELIBERATE_WRITE_FIXTURE=1` copies the result into this directory.

The engine-driven four are a pure function of the engine and the seeds, written by
`packages/server/src/bank/generate.ts`. The test regenerates them and holds the result to the
committed bytes, so a rules change shows up as a diff rather than as a silent rewrite.

`bank.json` is derived, never hand-edited — a hand-typed hash is a hash nobody checked.

## The injection bank runs with it

ALE-36's injection bank is not a second suite bolted on: it is an entry in this one.
`contracts/injection-bank.json` holds 52 adversarial player texts across nine families, and
each carries `demands` — the mutation that text was trying to cause. Both halves of the suite
read that one file:

- `services/gm/tests/test_injection.py` runs every case against the three walls — the text
  stays inside the speech fence and never reads as instruction, the model obeying it still gets
  an engine verdict rather than a mutation, and a `sandbox-escape` case's snippet fails and
  **returns** rather than hanging the turn. The model there is hostile by construction: the
  scripted fake does exactly what the case demanded.
- `injection-bank` in this bank replays the same 52 cases against the **real** engine: the
  player speaks the text, a game master that obeyed it attempts the demanded call, and the
  engine refuses all 52. The state hash is identical on every one of the 208 lines, from the
  header to the last turn. That is "no unvalidated mutation" as a replayable artifact rather
  than as a claim, and it runs free in `check` on every push.

Three cases are also run against the real model, gated on `ANTHROPIC_API_KEY` and excluded from
the default pytest run, because there is one question a fake cannot answer: whether
`claude-opus-5`, given this system prompt and this fenced block, treats the text as speech at
all. Low effort, three short turns, cents.

```sh
source ~/.deliberate-env && uv run pytest -m live -k injection   # in services/gm; spends money
```

The walls do not rest on that answer — the fake obeys every injection by construction and the
engine still refuses — which is why it is a supplement and not the gate.

Adding a case is a line of JSON plus `pnpm --filter @deliberate/server bank:write`.

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
a real model's tool sequence.

A live entry is a `Playthrough` in `packages/server/src/acceptance.test.ts` and a row in `LIVE` in
`packages/server/src/bank/write.ts`, and then:

```sh
source ~/.deliberate-env
DELIBERATE_SCRIPT=<name> DELIBERATE_WRITE_FIXTURE=1 \
  DELIBERATE_RECORDINGS=recordings/live \
  pnpm --filter @deliberate/server test -- acceptance   # ~$2 and ~15 minutes
git add recordings/bank/<name>.jsonl && git commit      # before anything else
pnpm --filter @deliberate/server bank:write             # derives the manifest row
```

**Commit the recording the moment it exists.** Three live playthroughs were run for ALE-24's
effort comparison, reported in `config.py`, and then lost — not committed, never on disk again.
That is roughly $6 and three ready-made bank entries gone, and the table they produced can no
longer be checked against anything. A live recording that is not committed does not exist. The
free policy suite exists for the same reason in miniature: it plays every script against a
scripted game master first, so a script that cannot reach a kill is found out before the money is
spent rather than after.

## One thing the bank found

`RecordingHeader` carried a snapshot and a seed but not the engine's `templates` table. `spawn`
reads that table, so any session in which the game master spawned did not replay, and a rejected
spawn did not either, because the rejection reason names the templates that were loaded. The header
now carries them (optional and omitted when empty, so older recordings are unaffected), the server
passes the scene's templates to the recorder, and `gatehouse-gm-tools` is the entry that keeps it
honest.

## Watching a bank entry

The bank is also the client's animation test material (ALE-19). `pnpm dev:client`, then
`http://127.0.0.1:5173/?replay=<name>`, plays any recording in `recordings/bank/` back through the
real renderer: the recording stands in for the server, and turns are paced by the animation queue
draining, so a turn can never start drawing before the one before it has finished.
`packages/client/src/replay.test.ts` steps the same sessions under node and asserts that nothing
overlaps; `e2e/replay.spec.ts` checks that a whole fight renders without a page error.
