# Vendored code in `services/gm`

Two files here start from the ARC-AGI-3 agent, which is itself vendored Tufa Labs "Duck"
ARC3-Inference (MIT), from the Kaggle dataset `jeroencottaar/taaf-kaggle-source-share`.
ARC-AGI-3 is Alex's own repo (MIT No Attribution, `~/Documents/arc-agi-3`) and is not on
GitHub, so the upstream files are not reachable from a cloud session. Both licences permit
this use; the chain is recorded here and in each file's module docstring.

| File here                         | Upstream                                    | Relationship                         |
| --------------------------------- | ------------------------------------------- | ------------------------------------ |
| `src/deliberate_gm/sandbox.py`    | `inference/agent/python_tool_sandbox.py`    | Adapted: same design, new RPC verb.  |
| `src/deliberate_gm/agent.py`      | `inference/agent/tool_agent.py`             | Re-implemented loop, same structure. |

## `sandbox.py`

Kept: the RPC design (a child process speaking JSON lines to the host, so the only way out of
the sandbox is a call the host executes), globals refreshed after every RPC, a host-enforced
wall-clock timeout that kills the process group, the restricted builtins set and import
allowlist, `resource` limits, and traceback sanitising so host paths never reach the model.

Replaced: the ARC `FrameView` / `HistoryEntryView` / segmentation machinery is gone, and the
`action(actions)` RPC became `gm_tool(name, **arguments)`, which the host forwards to the
engine like any other GM tool call. The ARC version's RPC executed game actions directly;
ours cannot, because the engine still validates every call.

## `agent.py`

The loop's shape is upstream's: call the model, parse tool calls, execute them, feed every
result back, trim history against a token budget by dropping whole exchanges, and keep a
verified ledger of what actually happened rather than what the model said happened.

Replaced wholesale: the prompts (ARC's puzzle-solving system prompt and scientist-note
addenda are gone; `prompt/system.py` is written for this game), the transport (upstream talks
to an OpenAI-compatible endpoint with `requests`; we use the Anthropic SDK behind the
`LLMClient` protocol), the tool surface, and the env-var feature gates — the ledger and the
batch-stop discipline are always on here, not behind `ARC3_DUCK_*` flags.

Upstream's history-trimming is far more elaborate than ours, because it was fitting a 32k
window. We have a 1M window and a 12k self-imposed budget, so `trim_messages` keeps only the
part that matters: the first user message is the anchor, and an assistant turn plus the tool
results answering it are one exchange that must be dropped together.

## Rules

Do not sync these files with upstream automatically. They have diverged on purpose and the
divergence is the point. If upstream fixes a sandbox escape, port the fix by hand and note it
here.
