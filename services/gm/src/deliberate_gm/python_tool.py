"""The sandboxed `python` tool.

Service-owned, so it is not in `contracts/gm-tools.json`: the contract describes the engine's
doors, and this is a place to think in code before opening one. Code runs in the vendored
sandbox and reaches the world only through `gm_tool(...)`, which the host forwards to the
engine exactly like any other GM tool call -- validation included.
"""

from __future__ import annotations

from typing import Any

from .agent import LocalTool, NestedCall
from .models import GmToolResult, TurnRequest
from .sandbox import run_sandboxed_python

PYTHON_TOOL_NAME = "python"

PYTHON_TOOL: dict[str, Any] = {
    "name": PYTHON_TOOL_NAME,
    "description": (
        "Run one short Python snippet to reason about the board before you act: measure "
        "distances, score candidate moves, compare options. Preloaded globals: `state` (the "
        "engine's state summary), `turn`, `phase`, `verdicts` and `last_verdict` (the engine "
        "verdicts your code has collected so far), and `gm_tool(name, **arguments)` which "
        "calls a GM tool and returns the engine's `{ok, reason, diff}` verdict. Assign to "
        "`result` to return a value; stdout is captured. Imports are restricted, there is no "
        "filesystem or network, and the snippet is killed if it runs too long."
    ),
    "strict": True,
    "input_schema": {
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "The Python snippet to run."},
        },
        "required": ["code"],
        "additionalProperties": False,
    },
}


def make_python_tool(*, timeout_seconds: int = 5) -> LocalTool:
    def run(request: TurnRequest, tool_input: dict[str, Any], nested: NestedCall) -> GmToolResult:
        code = tool_input.get("code")
        if not isinstance(code, str) or not code.strip():
            return GmToolResult(ok=False, kind="query", reason="the `code` argument was empty")

        def handle(tool: str, payload: dict[str, Any]) -> dict[str, Any]:
            verdict = nested(tool, payload if isinstance(payload, dict) else {})
            return {
                "verdict": verdict.model_dump(mode="json"),
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
        return GmToolResult(
            ok=not error,
            kind="query",
            reason=error or None,
            result={
                "stdout": outcome.get("stdout", ""),
                "result": outcome.get("result"),
            },
        )

    return run
