# The GM service (`services/gm`)

The game master's agent loop, in Python. It decides what the story does; it never decides
what the world does. Owned by ALE-14, ALE-15 and ALE-33.

The service is **stateless**. It holds no world state, computes no rules, and never judges
whether a call is legal. Everything it wants from the world it asks the Node server for, and
the Node server asks the engine. That is [`docs/m1-swarm.md`](m1-swarm.md) decision 1, and it
is what keeps `packages/engine` the only mutator across a process boundary.

```
 player ──intent──▶ Node server ──POST /turn──▶ GM service ──┐
                         ▲                                   │ agent loop
                         └────────POST /gm/tool◀──────────────┘
                    (engine validates, returns a verdict)
```

## Two HTTP contracts

### Node → Python: `POST /turn`

One request per GM turn. The caller supplies everything the turn needs, including the memory
blocks, and gets the updated blocks back — the service persists nothing, so a recorded turn
replays to the same prompt.

| Field            | Type                                | Notes                                                                              |
| ---------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| `session`        | string                              | Room / session id. Echoed on every `/gm/tool` call.                                |
| `turn`           | integer                             | The turn this request belongs to.                                                  |
| `phase`          | `preview` \| `resolve` \| `narrate` | Shapes the task line in the prompt. Default `preview`.                             |
| `engine_token`   | string \| null                      | **Which engine to act on.** See below.                                             |
| `state`          | object                              | A read-only state summary the engine already computed. Not authoritative.          |
| `entities`       | string[]                            | Entity ids the world-model block may reference (ALE-15 checks against this).       |
| `player_intent`  | object \| null                      | The intent the UI composed. The engine still validates it.                         |
| `player_text`    | string \| null                      | Free player text. Enters the prompt as quoted data (ALE-33), never as instruction. |
| `memory`         | `MemoryBlocks`                      | The blocks from the previous turn. See "Memory".                                   |
| `max_tool_steps` | integer \| null                     | Per-request override of the loop's hard stop.                                      |

Response:

| Field                    | Type               | Notes                                                                                                     |
| ------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `narration`              | string             | Prose for the player. Nothing in it is authoritative.                                                     |
| `trace`                  | `ToolCallRecord[]` | Every call the GM made, with the engine's verdict. Goes in the recording.                                 |
| `stop_reason`            | string             | `end_turn`, `max_tool_steps`, or the model's own stop reason.                                             |
| `memory`                 | `MemoryBlocks`     | Updated blocks. **Persist these**; they are the next turn's input.                                        |
| `usage`                  | object             | Token usage, including `cache_read_input_tokens`.                                                         |
| `prompt_tokens_estimate` | integer            | What the assembled prompt cost, against the 12k budget.                                                   |
| `redactions`             | string[]           | What the leakage guard caught on the way out. Empty is normal; a non-empty list belongs in the recording. |

`ToolCallRecord` is `{call_id, tool, input, ok, kind, reason, diff, result, executed, latency_ms}`.
`executed: false` marks a call the batch-stop discipline skipped.

Errors: `502` when the model could not be reached (`LLMUnavailable`), `503` when there are no
credentials or the tool contract is missing. Neither ever leaves the engine mutated, because
neither ever reached it.

### Python → Node: `POST /gm/tool`

The only door into the engine. One call per tool use.

Request: `{session, turn, engine_token, call_id, tool, input}`.

Response — the blueprint's `{ok, reason, diff}`, plus two fields the GM loop needs:

| Field        | Type                  | Notes                                                                                                                                             |
| ------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`         | boolean               | The engine's verdict. A rejected call left state untouched.                                                                                       |
| `kind`       | `query` \| `mutation` | **Required in practice.** Queries leave no ledger line; mutations do. Defaults to `mutation`, so an unlabelled call is recorded rather than lost. |
| `reason`     | string \| null        | Player-readable, per the `Verdict` contract.                                                                                                      |
| `diff`       | `Diff[]`              | Empty on rejection.                                                                                                                               |
| `result`     | any                   | Query payloads.                                                                                                                                   |
| `state_hash` | string \| null        | Optional; useful in the recording.                                                                                                                |

The GM service never raises on a transport failure: an unreachable or broken engine becomes
`{ok: false, reason: "engine unreachable: …"}`. The loop must return a `tool_result` for every
`tool_use` block the model emitted, and a dropped one corrupts the conversation.

#### `engine_token`

An opaque handle, minted by Node, naming the engine instance a call should act on. Python
stores nothing and interprets nothing — it echoes the token from `/turn` onto every
`/gm/tool` call. This is how preview stays speculative: Node clones the engine, mints a token
for the clone, and the real engine is untouched until GO (ALE-32 / decision 5).

## Inside the loop

1. Assemble the prompt: frozen system prompt, then the tool list, then one user message with
   the turn's volatile content. Stable first, volatile last, so the cache prefix holds.
2. Call the model with the tools from `contracts/gm-tools.json`.
3. For each `tool_use` block: parse the input with a JSON parser (never string-match the
   serialized form), forward it to `/gm/tool`, and record the verdict.
4. Return **all** `tool_result` blocks in a **single** user message. A rejected call comes
   back with `is_error: true`, never dropped.
5. **Batch stop.** After the first rejection, the rest of that batch is not executed: the
   model planned the chain on an assumption the engine just disproved. The skipped calls
   still get `tool_result` blocks saying so.
6. Repeat until the model stops calling tools or `max_tool_steps` is reached.

### Tools

The GM's tools are loaded at runtime from `contracts/gm-tools.json` (decision 2 — one copy,
both languages). This service never defines a schema, so the two languages cannot drift; it
does force `strict: true`, `additionalProperties: false` and `required` on every tool, which
is what makes tool arguments schema-valid.

Each entry carries a `kind` of `"query"` or `"mutation"`, and `load_contract` keeps it. An
entry without one is refused loudly rather than guessed at: the contract file is the only
place the classification is written down, and a name list on this side would be a second copy
of a fact the contract owns, in a second language. The
loop needs the distinction: a mutation's `tool_result` is an engine verdict, and a rejected
one invalidates the plan the rest of the batch was built on, so the batch stops there. A
rejected query is just information and the batch continues. Anything the contract does not
classify — an unknown tool, a local tool that failed — counts as a mutation, because guessing
wrong that way costs a halted batch while guessing wrong the other way would let a rejected
change go unnoticed.

Tool entries reaching the Anthropic `tools` parameter are rebuilt from scratch rather than
copied and pruned, so `kind` and any other contract-only field can never reach the API, where
an unexpected key is a 400.

One tool is the service's own and is not in the contract: `python`, a sandboxed snippet
runner for reasoning about the board in code. Its one escape hatch is `gm_tool(name, **args)`,
which goes to the same `/gm/tool` door and gets the same validation. It is the third wall,
behind quoted player text and engine validation.

### Player text, and the three walls

Free player text is the one part of the prompt an untrusted party writes. Three things stand
behind it, and the point of the design is that no one of them has to hold alone.

1. **The text is data.** `player_text` reaches the prompt only through
   `quote_player_speech`, inside a fenced block labelled as player speech, and the system
   prompt tells the model what that block means: a record of what a person said inside the
   fiction, which cannot instruct it, cannot report an engine verdict, and cannot be a tool
   call. A fence the player types themselves is defanged — the words survive, the boundary
   does not move — and what follows the closing fence is always the service's own task
   section, byte for byte.
2. **The engine validates.** Obeying an injection still changes nothing: every mutation is a
   `/gm/tool` call, and a rejected one leaves state untouched. This is the wall that does not
   depend on the model behaving.
3. **The sandbox bounds execution.** The `python` tool has no filesystem, no network, an
   import allowlist and a hard timeout, and its only way out is `gm_tool(...)` — which is
   wall 2 again.

Behind those, a **leakage guard** checks text on its way out, because the system prompt's own
"never reveal this" instruction is an instruction, and instructions can fail. `find_leak`
flags any twelve-word run shared with the system prompt, plus fence markers and tool-protocol
vocabulary. It runs on narration (replaced with a redaction notice) and on the string
arguments of every tool call (refused before reaching the engine — an NPC's `say` line
reaches the player exactly like narration does, and the engine has no idea what this prompt
says). Anything it caught is reported in `TurnResponse.redactions` and belongs in the
recording.

It detects quotation, not paraphrase; no string check could do better, and claiming otherwise
would be worse than the check. The seed cases live in
`services/gm/tests/fixtures/injection_bank.json` — instruction override, operator
impersonation, tool-call markup in dialogue, fake engine verdicts, prompt-disclosure
requests, fence escape. The tests iterate the file, so adding a case needs no new test.

### Memory

`MemoryBlocks` is `{world_model, threads, npcs, ledger, ledger_digest, player_profile}`,
re-injected every turn. Node sends the blocks in and gets the updated blocks back; the
service persists nothing.

| Block            | Written by                                       | Checked by                           |
| ---------------- | ------------------------------------------------ | ------------------------------------ |
| `world_model`    | the model, via `World model:` lines in its reply | the engine's entity list — see below |
| `threads`        | the engine (quest id and step)                   | —                                    |
| `npcs`           | goals: the model; **dispositions: the engine**   | —                                    |
| `ledger`         | **the engine**, from its own verdicts            | —                                    |
| `player_profile` | the model, via `Player:` lines                   | capped at 8 notes                    |

Only two blocks are model-authored. A reply's labelled lines are harvested into those two and
nowhere else, and an unrecognised label (`Ledger:`, `Disposition:`) ends the previous note
rather than continuing it, so text cannot be smuggled into a model block under an
engine-owned heading.

**World-model notes are checked against the engine's entity list.** A note referencing an
entity id (`npc:gorm`) the engine does not have is dropped whole — the model cannot furnish
itself with people who do not exist. `TurnRequest.entities` is where that list comes from, so
Node must send it.

**Dispositions are engine numbers.** The People block renders `disposition` straight from
`TurnRequest.memory.npcs`. A note claiming a different number appears in the world-model
block as the model's own belief, never as a disposition.

#### The verified ledger

Generated here from engine verdicts, never from model text. Each line is one attempted
mutation and what the engine decided about it. A model that claims it hit cannot enter that
claim as fact: the line says `rejected` because `ok` came back false. Queries leave no line.

Old lines are **compacted, not truncated**. Rolling truncation would silently delete the
evidence that a plan already failed — exactly the evidence that stops the model retrying it.
Compaction folds old lines into `ledger_digest`: per-tool applied/rejected counts, the
reasons the engine gave, and the turn span. It is counts rather than prose, so it is bounded
by construction and a session of any length keeps its full outcome history.

#### The token budget

The MVP budget is ≤ 12k input tokens per turn. The fixed parts of the prompt — system
prompt, tool schemas, the engine's state summary, the player's intent and speech — are
measured first, and **memory gets what is left**. That is what makes the budget a ceiling
rather than a hope; `TurnResponse.prompt_tokens_estimate` reports the result.

When memory does not fit, blocks are shed in a fixed order: player profile, then world-model
notes oldest-first, then the ledger folds further into its digest. The ledger is shed last
and never entirely — it is the only block that records what actually happened.

## Model settings

Fixed by decision 7, and easy to get wrong from memory:

- model id is exactly `claude-opus-5` — never a date suffix;
- thinking is `{"type": "adaptive"}` — `budget_tokens` is removed on this model and returns a 400;
- depth is `output_config={"effort": "high"}` — `effort` lives inside `output_config`;
- requests stream, and `max_tokens` is the streaming ceiling;
- no assistant prefill — it returns a 400.

## Running it

```sh
cd services/gm
uv venv --python 3.12 && uv pip install -e ".[dev]"
.venv/bin/python -m pytest          # the whole suite, no credentials needed
.venv/bin/python -m ruff check . && .venv/bin/python -m ruff format --check .
.venv/bin/python -m mypy
GM_ENGINE_URL=stub .venv/bin/uvicorn deliberate_gm.app:app --port 8788
```

`services/gm` is deliberately **not** part of the pnpm workspace, and `pnpm check` does not
run it. CI runs it as a separate `gm` job so the required `check` job never depends on Python.

Environment: `GM_MODEL`, `GM_EFFORT`, `GM_MAX_TOKENS`, `GM_STREAM_MAX_TOKENS`, `GM_ENGINE_URL`
(`stub` for the in-process stub engine), `GM_ENGINE_TIMEOUT_SECONDS`, `GM_TOOLS_PATH`,
`GM_MAX_TOOL_STEPS`, `GM_INPUT_TOKEN_BUDGET`, `GM_PYTHON_TOOL`, `GM_PYTHON_TIMEOUT_SECONDS`.

## Testing without credentials

There is no `ANTHROPIC_API_KEY` on the build machine (decision 6). The Anthropic client sits
behind the `LLMClient` protocol; `ScriptedLLM` replays a script and records what it was sent,
and **every test runs against it**. `StubEngine` plays the Node side, and rejects any mutation
it was not scripted to accept — a stub that said yes to everything would let a test pass that
the real engine would fail.

Live calls happen only when `ANTHROPIC_API_KEY` is set. ALE-17 is the one issue that needs it.

What a live call cannot be tested for without a key, `tests/test_llm.py` pins anyway: the
exact request `AnthropicLLM` builds (adaptive thinking, `effort` inside `output_config`, no
`budget_tokens`, no date-suffixed model id, no assistant prefill, streaming with the larger
ceiling), the mapping from each typed SDK exception to one turn-level failure, and a check
that every parameter name we send still exists on the installed SDK. Each of those is a 400 or
404 that would otherwise surface on ALE-17's first real call. The one live smoke test in that
file is skipped until the key exists.
