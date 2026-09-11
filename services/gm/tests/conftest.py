"""Shared fixtures. Every test here runs against the scripted fake: there are no API
credentials on the build machine and no test may depend on one."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from deliberate_gm.config import Settings
from deliberate_gm.contracts import load_tools
from deliberate_gm.llm import LLMResult
from deliberate_gm.models import TurnRequest
from deliberate_gm.stub_engine import StubEngine

FIXTURE_TOOLS = Path(__file__).parent / "fixtures" / "gm-tools.json"
REPO_ROOT = Path(__file__).resolve().parents[3]
#: ALE-31 owns this file. When it lands, the contract tests start checking it for real.
REAL_CONTRACT = REPO_ROOT / "contracts" / "gm-tools.json"


@pytest.fixture
def settings() -> Settings:
    return Settings(tools_path=FIXTURE_TOOLS, engine_url="stub", python_tool_enabled=False)


@pytest.fixture
def tools() -> list[dict[str, Any]]:
    return load_tools(FIXTURE_TOOLS)


@pytest.fixture
def engine() -> StubEngine:
    return StubEngine(state={"entities": ["pc:ari", "npc:gorm"], "turn": 1})


@pytest.fixture
def turn_request() -> TurnRequest:
    return TurnRequest(
        session="room-1",
        turn=1,
        phase="preview",
        engine_token="engine:preview:1",
        state={"entities": ["pc:ari", "npc:gorm"]},
        entities=["pc:ari", "npc:gorm"],
        player_intent={
            "kind": "attack",
            "attacker": "pc:ari",
            "target": "npc:gorm",
            "ability": "sword",
        },
    )


def say(text: str, *, stop_reason: str = "end_turn") -> LLMResult:
    return LLMResult(
        content=[{"type": "text", "text": text}],
        stop_reason=stop_reason,
        usage={"input_tokens": 100, "output_tokens": 20},
    )


def call(*calls: tuple[str, dict[str, Any]], text: str = "") -> LLMResult:
    """One assistant reply holding one or more `tool_use` blocks."""
    content: list[dict[str, Any]] = []
    if text:
        content.append({"type": "text", "text": text})
    for index, (name, payload) in enumerate(calls):
        content.append(
            {"type": "tool_use", "id": f"toolu_{name}_{index}", "name": name, "input": payload}
        )
    return LLMResult(
        content=content,
        stop_reason="tool_use",
        usage={"input_tokens": 100, "output_tokens": 30},
    )
