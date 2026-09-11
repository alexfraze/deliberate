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

| Field                    | Type               | Notes                                                                     |
| ------------------------ | ------------------ | ------------------------------------------------------------------------- |
| `narration`              | string             | Prose for the player. Nothing in it is authoritative.                     |
| `trace`                  | `ToolCallRecord[]` | Every call the GM made, with the engine's verdict. Goes in the recording. |
| `stop_reason`            | string             | `end_turn`, `max_tool_steps`, or the model's own stop reason.             |
| `memory`                 | `MemoryBlocks`     | Updated blocks. **Persist these**; they are the next turn's input.        |
| `usage`                  | object             | Token usage, including `cache_read_input_tokens`.                         |
| `prompt_tokens_estimate` | integer            | What the assembled prompt cost, against the 12k budget.                   |

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

One tool is the service's own and is not in the contract: `python`, a sandboxed snippet
runner for reasoning about the board in code. Its one escape hatch is `gm_tool(name, **args)`,
which goes to the same `/gm/tool` door and gets the same validation. It is the third wall,
behind quoted player text and engine validation.

### Memory

`MemoryBlocks` is `{world_model, threads, npcs, ledger, player_profile}`, re-injected every
turn and capped at 12k input tokens (ALE-15).

The **verified ledger** is generated here from engine verdicts, never from model text. Each
line records an attempted mutation and what the engine decided about it. A model that claims
it hit cannot enter that claim as fact: the line says `rejected` because `ok` came back
false.

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
