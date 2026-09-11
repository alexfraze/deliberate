"""A stub engine, for running and testing the service without the Node server.

It answers queries from the state summary it was handed and *rejects every mutation it was
not scripted to accept*. That default matters: a stub that said yes to everything would let
a test pass that the real engine would fail. It is not a rules engine and never will be --
ALE-31 owns the real handlers.
"""

from __future__ import annotations

from typing import Any

from .models import GmToolCall, GmToolResult

DEFAULT_REJECTION = "the stub engine validates nothing; only scripted calls are accepted"


class StubEngine:
    """Scripted verdicts keyed by tool name, with a recorded call log."""

    def __init__(
        self,
        *,
        state: dict[str, Any] | None = None,
        verdicts: dict[str, GmToolResult] | None = None,
    ) -> None:
        self.state = state or {}
        self.verdicts = verdicts or {}
        self.calls: list[GmToolCall] = []

    def accept(self, tool: str, *, diff: list[dict[str, Any]] | None = None) -> None:
        self.verdicts[tool] = GmToolResult(ok=True, kind="mutation", diff=diff or [])

    def answer(self, tool: str, result: Any) -> None:
        self.verdicts[tool] = GmToolResult(ok=True, kind="query", result=result)

    def reject(self, tool: str, reason: str) -> None:
        self.verdicts[tool] = GmToolResult(ok=False, kind="mutation", reason=reason)

    def call(self, call: GmToolCall) -> GmToolResult:
        self.calls.append(call)
        scripted = self.verdicts.get(call.tool)
        if scripted is not None:
            return scripted.model_copy(deep=True)
        if call.tool == "get_state":
            return GmToolResult(ok=True, kind="query", result=self.state)
        return GmToolResult(ok=False, kind="mutation", reason=DEFAULT_REJECTION)
