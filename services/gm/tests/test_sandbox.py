"""The vendored sandbox, adapted: the RPC is `gm_tool`, and it is the only way out."""

from __future__ import annotations

from typing import Any

from deliberate_gm.sandbox import run_sandboxed_python


def no_tools(tool: str, payload: dict[str, Any]) -> dict[str, Any]:
    raise AssertionError(f"unexpected tool call {tool!r}")


def test_code_runs_and_returns_a_result() -> None:
    outcome = run_sandboxed_python(
        code="print('thinking'); result = sorted(state['entities'])",
        timeout_seconds=5,
        context={"state": {"entities": ["b", "a"]}, "turn": 1, "phase": "preview"},
        tool_handler=no_tools,
    )
    assert outcome["error"] == ""
    assert outcome["result"] == ["a", "b"]
    assert "thinking" in outcome["stdout"]


def test_gm_tool_is_the_only_way_to_touch_the_world() -> None:
    seen: list[tuple[str, dict[str, Any]]] = []

    def handler(tool: str, payload: dict[str, Any]) -> dict[str, Any]:
        seen.append((tool, payload))
        return {
            "verdict": {"ok": False, "reason": "out of range", "diff": []},
            "state": {"entities": []},
            "turn": 1,
            "phase": "preview",
        }

    outcome = run_sandboxed_python(
        code="result = gm_tool('attack', attacker='pc:ari', target='npc:gorm')",
        timeout_seconds=5,
        context={"state": {}, "turn": 1, "phase": "preview"},
        tool_handler=handler,
    )
    assert seen == [("attack", {"attacker": "pc:ari", "target": "npc:gorm"})]
    # The engine said no, and the sandbox reports exactly that.
    assert outcome["result"]["ok"] is False
    assert outcome["result"]["reason"] == "out of range"


def test_globals_are_refreshed_after_every_call() -> None:
    states = [{"hp": 10}, {"hp": 3}]

    def handler(tool: str, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "verdict": {"ok": True},
            "state": states.pop(0),
            "turn": 1,
            "phase": "preview",
        }

    outcome = run_sandboxed_python(
        code=(
            "before = state['hp']\n"
            "gm_tool('attack')\n"
            "mid = state['hp']\n"
            "gm_tool('attack')\n"
            "result = [before, mid, state['hp'], len(verdicts)]"
        ),
        timeout_seconds=5,
        context={"state": {"hp": 20}, "turn": 1, "phase": "preview"},
        tool_handler=handler,
    )
    assert outcome["result"] == [20, 10, 3, 2]


def test_filesystem_and_network_imports_are_refused() -> None:
    for module in ("os", "socket", "subprocess", "pathlib"):
        outcome = run_sandboxed_python(
            code=f"import {module}",
            timeout_seconds=5,
            context={"state": {}, "turn": 1, "phase": "preview"},
            tool_handler=no_tools,
        )
        assert "not allowed in the sandbox" in outcome["error"], module


def test_builtins_that_escape_are_absent() -> None:
    for snippet in ("open('/etc/passwd')", "eval('1')", "exec('x=1')", "__import__('os')"):
        outcome = run_sandboxed_python(
            code=f"result = {snippet}",
            timeout_seconds=5,
            context={"state": {}, "turn": 1, "phase": "preview"},
            tool_handler=no_tools,
        )
        assert outcome["error"], snippet


def test_an_endless_loop_is_killed() -> None:
    outcome = run_sandboxed_python(
        code="while True:\n    pass",
        timeout_seconds=1,
        context={"state": {}, "turn": 1, "phase": "preview"},
        tool_handler=no_tools,
    )
    assert "timed out" in outcome["error"]


def test_a_traceback_does_not_leak_host_paths() -> None:
    outcome = run_sandboxed_python(
        code="raise ValueError('boom')",
        timeout_seconds=5,
        context={"state": {}, "turn": 1, "phase": "preview"},
        tool_handler=no_tools,
    )
    assert "ValueError: boom" in outcome["error"]
    assert "deliberate_gm" not in outcome["error"]
    assert "<gm_python>" in outcome["error"]
