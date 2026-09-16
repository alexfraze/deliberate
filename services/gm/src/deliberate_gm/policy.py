"""NPC code brains (ALE-37): the policies the game master writes, and the runner that executes
them with no model in the loop.

The shape of the idea, from the roadmap: in combat every NPC turn is one sequential Claude call,
and that is the whole p95 tail. A *policy* is a short Python program the game master writes once
for an NPC in a situation -- "close with the nearest living enemy of another faction, attack if
adjacent, end the turn" -- which the server then runs itself each turn until the situation
changes. The model is paid once for the strategy instead of once per turn for the tactics.

Three things make that safe, and none of them is new:

1. **The policy runs in the existing sandbox.** `sandbox.py` is untouched by this module: same
   process-group kill on timeout, same restricted builtins, same import allowlist, same bare
   environment, same single escape hatch. A policy is exactly as contained as a `python` snippet
   because it *is* a `python` snippet, with a different lifetime.
2. **A policy proposes; the engine disposes.** Its only way out is `gm_tool(name, **arguments)`,
   which is `POST /gm/tool` -- the same validated door, the same `{ok, reason, diff}` verdict. A
   policy cannot mutate anything, and an illegal action it proposes is refused exactly as the
   model's own would be.
3. **A policy is smoke-tested before it is ever cached.** `save_policy` runs the code in the
   sandbox against a *dry-run* `gm_tool` that collects calls instead of forwarding them. Code that
   raises, hangs, or calls nothing is refused at the moment it is written, with a reason the model
   can act on, and never reaches the cache.

What a policy is *not* is a source of truth. Nothing here is consulted during replay: a recorded
session replays from its intents through the engine, and whether an intent was decided by the
model or by a policy is not a fact the engine can see. See `docs/gm-service.md`.
"""

from __future__ import annotations

import ast
import time
from dataclasses import dataclass
from typing import Any

from .agent import LocalTool, NestedCall
from .engine_client import EngineClient
from .models import (
    GmToolCall,
    GmToolResult,
    PolicyRequest,
    PolicyResponse,
    ToolCallRecord,
    TurnRequest,
)
from .prompt import scan_strings
from .sandbox import run_sandboxed_python

SAVE_POLICY_TOOL_NAME = "save_policy"

#: Hard cap on the GM tool calls one policy execution may make. The sandbox timeout already
#: bounds wall time; this bounds *work*, so a policy that loops on a verdict it keeps
#: misreading cannot spend the whole encounter's budget in one turn. Past the cap every further
#: call comes back refused, which the policy sees like any other verdict.
MAX_POLICY_CALLS = 12

CALL_LIMIT = (
    f"not executed: this policy has already made {MAX_POLICY_CALLS} calls this turn, which is "
    "the limit. End the actor's turn."
)

#: Refused before the call leaves this process, for the same reason the agent loop refuses one:
#: the engine has no idea what this service's prompt says, so this wall can only be built here.
LEAK_REFUSED = (
    "not executed: this call would have carried part of the game master's own instructions to "
    "the player."
)


@dataclass
class PolicyDraft:
    """Where `save_policy` puts the code it accepted, for one `/turn` request.

    A turn writes at most one policy; a second `save_policy` call replaces the first, because the
    model revising its own program is the normal way a rejected draft gets fixed.
    """

    code: str | None = None
    note: str = ""


SAVE_POLICY_TOOL: dict[str, Any] = {
    "name": SAVE_POLICY_TOOL_NAME,
    "description": (
        "Save a reusable Python policy for the NPC whose turn it is, so the server can take "
        "that NPC's later turns itself without asking you. Write the *strategy*, not this "
        "turn's move: the code is re-run from scratch at the start of every one of that NPC's "
        "turns, against whatever the world looks like then.\n"
        "\n"
        "The code runs at top level with the same globals as the `python` tool: `state` (the "
        "engine's state summary for that turn, with `state['acting']` naming the NPC the policy "
        "is running for), `turn`, `phase`, and `gm_tool(name, **arguments)`, which calls a GM "
        "tool and returns the engine's `{ok, reason, diff}` verdict. Read the verdict and branch "
        "on it; a refusal means that action did not happen.\n"
        "\n"
        "A good policy reads `state` to find itself and its targets, decides from what it finds, "
        "makes its calls, and always ends by calling `end_turn` for itself. It must not assume "
        "anything about positions, hit points or who is alive -- all of that is in `state` and "
        "all of it will have moved by the next turn.\n"
        "\n"
        "Saving runs the code once as a dry run: the calls it would make are collected and "
        "reported back to you, and nothing reaches the world. Code that raises, runs too long, "
        "or calls no tool is refused with the reason, and you should fix it and save again. "
        "Imports are restricted and there is no filesystem or network."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "code": {
                "type": "string",
                "description": "The policy program. Runs top level; must call `end_turn`.",
            },
            "note": {
                "type": "string",
                "description": "One line on what this policy does, for the trace.",
            },
        },
        "required": ["code", "note"],
        "additionalProperties": False,
    },
}


def make_save_policy_tool(draft: PolicyDraft, *, timeout_seconds: int = 5) -> LocalTool:
    """The `save_policy` local tool, writing into `draft`.

    Local, and deliberately not in `contracts/gm-tools.json`: the contract describes the engine's
    doors, and this opens none of them. It is a `query` -- it changes nothing, and the code it
    saves changes nothing either until the server chooses to run it.
    """

    def run(request: TurnRequest, tool_input: dict[str, Any], nested: NestedCall) -> GmToolResult:
        code = tool_input.get("code")
        if not isinstance(code, str) or not code.strip():
            return GmToolResult(ok=False, kind="query", reason="the `code` argument was empty")
        try:
            # Parsing is not executing. A program that cannot parse cannot be smoke-tested
            # either, and the SyntaxError says where, which is what the model needs.
            ast.parse(code)
        except SyntaxError as exc:
            return GmToolResult(
                ok=False,
                kind="query",
                reason=f"the policy does not parse: {exc.msg} (line {exc.lineno})",
            )

        proposed: list[dict[str, Any]] = []

        def handle(tool: str, payload: dict[str, Any]) -> dict[str, Any]:
            # The dry run's engine is a tally. Saying `ok` to everything is right here: the
            # question this run answers is "does the program run and act", not "would the world
            # allow it" -- that one only the real engine may answer, on the turn it is asked.
            if len(proposed) >= MAX_POLICY_CALLS:
                verdict: dict[str, Any] = {"ok": False, "kind": "mutation", "reason": CALL_LIMIT}
            else:
                proposed.append({"tool": tool, "input": payload})
                verdict = {"ok": True, "kind": "mutation", "reason": None, "diff": []}
            return {
                "verdict": verdict,
                "state": request.state,
                "turn": request.turn,
                "phase": request.phase,
            }

        outcome = run_sandboxed_python(
            code=code,
            timeout_seconds=timeout_seconds,
            context={"state": request.state, "turn": request.turn, "phase": request.phase},
            tool_handler=handle,
        )
        error = str(outcome.get("error") or "")
        if error:
            return GmToolResult(ok=False, kind="query", reason=f"the policy did not run: {error}")
        if not proposed:
            return GmToolResult(
                ok=False,
                kind="query",
                reason=(
                    "the policy ran but called no GM tool. A policy has to act and then call "
                    "`end_turn` for the acting entity, or the server would have nothing to run."
                ),
            )

        draft.code = code
        draft.note = str(tool_input.get("note") or "")
        return GmToolResult(
            ok=True,
            kind="query",
            result={
                "saved": True,
                "would_call": proposed,
                "stdout": str(outcome.get("stdout", "") or ""),
            },
        )

    return run


def run_policy(
    request: PolicyRequest,
    *,
    engine: EngineClient,
    timeout_seconds: int = 5,
) -> PolicyResponse:
    """Execute a saved policy for one NPC turn. No model, no memory, no prompt.

    This is the whole point of the issue: the expensive part of an NPC turn was a Claude call, and
    what replaces it is a subprocess and a handful of localhost round trips. The returned trace has
    the same shape a `/turn` trace has, because the calls went through the same door and came back
    with the same verdicts -- so Node's bookkeeping, its recording and its meters do not have to
    know which of the two produced a turn.
    """
    records: list[ToolCallRecord] = []

    def handle(tool: str, payload: dict[str, Any]) -> dict[str, Any]:
        call_id = f"policy-{request.turn}-{len(records)}"
        if len(records) >= MAX_POLICY_CALLS:
            verdict = GmToolResult(ok=False, kind="mutation", reason=CALL_LIMIT)
            records.append(
                ToolCallRecord(
                    call_id=call_id,
                    tool=tool,
                    input=payload,
                    ok=False,
                    kind="mutation",
                    reason=CALL_LIMIT,
                    executed=False,
                )
            )
        elif scan_strings(payload) is not None:
            verdict = GmToolResult(ok=False, kind="mutation", reason=LEAK_REFUSED)
            records.append(
                ToolCallRecord(
                    call_id=call_id,
                    tool=tool,
                    input=payload,
                    ok=False,
                    kind="mutation",
                    reason=LEAK_REFUSED,
                    executed=False,
                )
            )
        else:
            started = time.monotonic()
            verdict = engine.call(
                GmToolCall(
                    session=request.session,
                    turn=request.turn,
                    engine_token=request.engine_token,
                    call_id=call_id,
                    tool=tool,
                    input=payload,
                )
            )
            records.append(
                ToolCallRecord(
                    call_id=call_id,
                    tool=tool,
                    input=payload,
                    ok=verdict.ok,
                    kind=verdict.kind,
                    reason=verdict.reason,
                    diff=verdict.diff,
                    result=verdict.result,
                    latency_ms=int((time.monotonic() - started) * 1000),
                )
            )
        # Refreshed state would be better than the summary Node sent, but asking the engine for
        # it would cost a round trip per call for a policy that mostly does not re-read. A policy
        # that needs the world after acting calls `get_state`, which is a query and free.
        return {
            "verdict": verdict.model_dump(mode="json"),
            "state": request.state,
            "turn": request.turn,
            "phase": "resolve",
        }

    outcome = run_sandboxed_python(
        code=request.code,
        timeout_seconds=timeout_seconds,
        context={"state": request.state, "turn": request.turn, "phase": "resolve"},
        tool_handler=handle,
    )
    error = str(outcome.get("error") or "")
    return PolicyResponse(
        session=request.session,
        turn=request.turn,
        ok=not error,
        error=error or None,
        trace=records,
        stdout=str(outcome.get("stdout", "") or ""),
    )


__all__ = [
    "CALL_LIMIT",
    "LEAK_REFUSED",
    "MAX_POLICY_CALLS",
    "PolicyDraft",
    "SAVE_POLICY_TOOL",
    "SAVE_POLICY_TOOL_NAME",
    "make_save_policy_tool",
    "run_policy",
]
