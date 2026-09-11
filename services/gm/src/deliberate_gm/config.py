"""Settings for the GM service. Every knob is an environment variable so the Node server,
CI and a developer shell can all configure the service without editing code."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

#: Model defaults are fixed by docs/m1-swarm.md decision 7. `budget_tokens` does not appear
#: anywhere in this service: it is removed on this model and returns a 400.
DEFAULT_MODEL = "claude-opus-5"
DEFAULT_EFFORT = "high"


def _repo_root() -> Path:
    # services/gm/src/deliberate_gm/config.py -> repo root
    return Path(__file__).resolve().parents[4]


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    """Immutable, so the frozen prompt prefix really is frozen for the life of a process."""

    model: str = DEFAULT_MODEL
    effort: str = DEFAULT_EFFORT
    #: Non-streaming ceiling. Narration streams and uses `stream_max_tokens` instead.
    max_tokens: int = 16_000
    stream_max_tokens: int = 64_000
    #: Base URL of the Node game server. `stub` runs against the in-process stub engine.
    engine_url: str = "http://127.0.0.1:8787"
    engine_timeout_seconds: float = 10.0
    #: One JSON file, both languages (docs/m1-swarm.md decision 2).
    tools_path: Path = Path("contracts/gm-tools.json")
    #: Hard stop on the agent loop so a turn cannot run forever.
    max_tool_steps: int = 8
    #: MVP budget from the blueprint: <= 12k input tokens per turn.
    input_token_budget: int = 12_000
    #: The sandboxed `python` tool. Off by default in `preview`; see docs/gm-service.md.
    python_tool_enabled: bool = True
    python_timeout_seconds: int = 5

    @classmethod
    def from_env(cls) -> Settings:
        tools_path = os.environ.get("GM_TOOLS_PATH")
        return cls(
            model=os.environ.get("GM_MODEL", DEFAULT_MODEL),
            effort=os.environ.get("GM_EFFORT", DEFAULT_EFFORT),
            max_tokens=_env_int("GM_MAX_TOKENS", 16_000),
            stream_max_tokens=_env_int("GM_STREAM_MAX_TOKENS", 64_000),
            engine_url=os.environ.get("GM_ENGINE_URL", "http://127.0.0.1:8787"),
            engine_timeout_seconds=_env_float("GM_ENGINE_TIMEOUT_SECONDS", 10.0),
            tools_path=Path(tools_path)
            if tools_path
            else _repo_root() / "contracts" / "gm-tools.json",
            max_tool_steps=_env_int("GM_MAX_TOOL_STEPS", 8),
            input_token_budget=_env_int("GM_INPUT_TOKEN_BUDGET", 12_000),
            python_tool_enabled=os.environ.get("GM_PYTHON_TOOL", "1") == "1",
            python_timeout_seconds=_env_int("GM_PYTHON_TIMEOUT_SECONDS", 5),
        )


def live_api_available() -> bool:
    """True when a real Claude call is possible. There are no credentials on the build
    machine, so every live path is gated on this and skipped when it is False."""
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
