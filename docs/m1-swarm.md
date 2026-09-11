# M1 swarm launch plan

Goal: milestone **M1 The game master arrives**. M0 shipped a playable skeleton with no model in
the loop; M1 puts an agentic Claude game master behind the turn, without weakening engine
authority.

M1 exit (ALE-17): a ten-turn playthrough end to end with zero direct state edits, every GM
mutation carrying an engine verdict in the recording, and the recording replaying to identical
hashes.

## Decisions made before the swarm starts

These are the hard edges. They are fixed here so four agents do not each invent an answer.

### 1. The GM loop lives in Python; the engine stays the only mutator

The blueprint gives the LLM service the agent loop and the tool contract, and gives the game
server turn orchestration and the entity store. So the loop and the state live in different
processes, and every GM tool call has to cross that boundary.

| Option                                                 | Verdict                                                                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Python runs the loop, calls back to Node per tool call | **Chosen.** One engine, one source of truth. Localhost round trips are sub-millisecond against an 8 s preview budget. |
| Node runs the loop, Python only "decides"              | Rejected. Contradicts the blueprint's ownership split and splits the agent loop across two languages.                 |
| Port the engine to Python                              | Rejected. Two rule implementations is exactly the drift the determinism rule exists to prevent.                       |

So: the Node server exposes `POST /gm/tool`, the only door into the engine for the GM. Python
never holds state, never computes rules, and never decides whether a call is legal.

### 2. Tool schemas are plain JSON in `contracts/gm-tools.json`

Both languages need the same schemas. Rather than define them twice, or add a codegen step, the
schemas are one JSON file at the repo root that TypeScript imports and types, and Python loads and
passes straight to the Anthropic `tools` parameter. Fewest moving parts, and drift is impossible
because there is only one copy.

### 3. New intent kinds are an additive protocol change

M0 shipped `move`, `attack`, `end_turn`. M1 adds `cast`, `say`, `set_disposition`, `spawn`,
`set_flag`, `advance_quest`. Additive only, per CLAUDE.md; call it out in the PR.

Every GM mutation tool maps onto exactly one `Intent`. A GM tool call is not a new mutation path —
it is the same validated path the UI uses. `say` is the one tool that mutates nothing but the
dialogue stream (it emits a `DialogueLine` diff, a state no-op).

### 4. Queries are free and read-only

`get_state`, `legal_actions`, `line_of_sight`, `path`, `recall`, `roll_preview` never mutate.
`roll_preview` must not consume RNG — it reports odds from a _copy_ of the seeded stream, or the
next roll silently changes and replays diverge.

### 5. Preview must not mutate

Preview runs the GM speculatively against a **cloned** engine. The real engine is untouched until
GO. This is the acceptance criterion for ALE-32 and the easiest thing in M1 to get wrong.

### 6. No API credentials on the build machine

There is no `ANTHROPIC_API_KEY` and no `ant` CLI here. Everything in M1 except the live
playthrough must therefore be testable **without** credentials: the Anthropic client sits behind a
small interface with a scripted fake, and tests use the fake. Live calls are gated behind the env
var and skipped when it is absent. ALE-17 is the one issue that needs a real key.

### 7. Model defaults

`claude-opus-5`. Adaptive thinking (`thinking={"type": "adaptive"}`) — **never** `budget_tokens`,
which is rejected with a 400 on this model. Depth is controlled with
`output_config={"effort": ...}`. Narration streams. Do not invent date-suffixed model ids.

## Layout

| Path                      | Linear | Notes                                                    |
| ------------------------- | ------ | -------------------------------------------------------- |
| `contracts/gm-tools.json` | ALE-31 | The tool schemas. One copy, both languages.              |
| `packages/protocol/src/`  | ALE-31 | New intent kinds, GM call/verdict shapes.                |
| `packages/engine/src/gm/` | ALE-31 | Query handlers and the tool-call → intent mapping.       |
| `packages/server/src/gm/` | ALE-32 | `POST /gm/tool`, the GM service client, preview-then-GO. |
| `packages/client/`        | ALE-32 | Preview UI, GO button, narration stream.                 |
| `services/gm/`            | ALE-14 | Python 3.12 FastAPI, uv. Not in the pnpm workspace.      |
| `services/gm/memory/`     | ALE-15 | Memory blocks and the verified ledger.                   |
| `services/gm/prompt/`     | ALE-33 | Prompt assembly, player text as data, injection bank.    |
| `content/npcs/`           | ALE-16 | The three archetypes.                                    |
| `docs/gm-service.md`      | ALE-14 | The Node ↔ Python HTTP contract.                         |

## Agents

| Agent | Issues (in order)        | Owns                                 | Points |
| ----- | ------------------------ | ------------------------------------ | ------ |
| P     | ALE-31                   | contracts, protocol, `engine/src/gm` | 5      |
| Q     | ALE-14 → ALE-15 → ALE-33 | `services/gm/` (all Python)          | 10     |
| R     | ALE-16                   | `content/npcs/`                      | 3      |
| T     | ALE-32                   | `server/src/gm`, client preview UI   | 5      |
| U     | ALE-17                   | acceptance, after P/Q/R/T merge      | 1      |

P, Q and R start together and are disjoint by construction: a TypeScript contract, a Python
service, and content. T needs P's intents and Q's service shape, so it starts when ALE-31 merges
and codes against a stub GM for the parts Q has not landed.

The verified ledger (ALE-15) is **engine-generated**, not model-authored: it records what the
engine decided, so a model that claims it hit cannot enter that claim as fact. That is the whole
point of the block and it is ALE-15's acceptance criterion.
