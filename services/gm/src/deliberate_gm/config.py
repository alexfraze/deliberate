"""Settings for the GM service. Every knob is an environment variable so the Node server,
CI and a developer shell can all configure the service without editing code."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

#: Model defaults are fixed by docs/m1-swarm.md decision 7. `budget_tokens` does not appear
#: anywhere in this service: it is removed on this model and returns a 400.
DEFAULT_MODEL = "claude-opus-5"

#: Effort was `high` through M1 and is `medium` from ALE-24, on measurement rather than taste.
#: Three ten-turn playthroughs of the ALE-16 gatehouse against the live model, identical beats,
#: read back out of their recordings with `pnpm meters`:
#:
#:     effort   preview p50   after-GO p50   after-GO p95   $/turn    GM mutations
#:     high        30.1 s         9.4 s         78.0 s      $0.2585        61
#:     medium      23.5 s         8.8 s         26.6 s      $0.1853        57
#:     low         16.4 s         4.6 s         23.5 s      $0.1370        35
#:
#: `medium` is the setting that costs nothing to take: it clears M3's "p50 after GO under 10 s"
#: with margin, cuts the p95 tail by 2.9x, saves 28% per turn, and the game master still does as
#: much -- 57 mutations against high's 61, and the acceptance run passes unchanged.
#:
#: `low` is faster and cheaper again and it also passes, but it visibly thins the world: 35
#: mutations, 43% fewer than `high`. That is a game-design call about how much the game master
#: should do per turn, not a latency decision, so it is left to `GM_EFFORT=low` rather than taken
#: here. `GM_EFFORT` is the one-line change either way.
#:
#: **The three recordings that table was read from were never committed and are gone**, so the
#: `high` and `low` rows cannot be checked against anything any more. ALE-25 re-measured `medium`
#: on two playthroughs whose bytes *are* in `recordings/bank/`, and the row holds where it matters
#: and does not where it does not:
#:
#:     session       preview p50   after-GO p50   after-GO p95   $/turn
#:     yard-brawl      30.3 s          8.0 s         27.6 s      $0.2086
#:     parley          27.1 s          8.1 s         10.8 s      $0.1711
#:
#: after-GO p50 reproduces (8.0-8.1 s against 8.8 s) and still clears the ten-second gate. Preview
#: is worse than the table says (27-30 s against 23.5 s). The p95 and the price are not properties
#: of the effort setting at all, they are properties of the *session*: the combat run's tail is
#: 2.6x the dialogue run's, because a turn where several NPCs each cost a model call is several
#: model calls. That is ALE-37 (NPC code brains), not effort tuning.
#:
#: `pnpm meters recordings/bank/<name>.jsonl` re-prints both rows with no key and no network.
DEFAULT_EFFORT = "medium"


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
    #: One JSON file, both languages (docs/m1-swarm.md decision 2). Resolved from this
    #: file's location rather than the working directory, so `Settings()` and
    #: `Settings.from_env()` find the same contract wherever the service is started from.
    tools_path: Path = field(default_factory=lambda: _repo_root() / "contracts" / "gm-tools.json")
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
