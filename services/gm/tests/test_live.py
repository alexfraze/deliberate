"""The one test that talks to Claude.

Everything else in this suite runs against a scripted fake, which is what makes the suite
runnable without credentials -- and is exactly why it could not catch a payload the API
rejects. It did not: `strict: true` on the real 15-tool contract is a 400, and the fake said
nothing, because a fake cannot refuse a request the real endpoint would.

So this file exists to send the real thing. It is marked `live`, excluded from the default
run by `addopts` in pyproject.toml, and skipped anyway when there is no key -- CI has none.
Run it deliberately:

    source ~/.deliberate-env && uv run pytest -m live

It costs money. It is also the only check that the request we build is *accepted* rather than
merely well-formed, so ALE-17 should run it first, and any change to the tool payload or the
model settings should run it before merging.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from deliberate_gm.config import Settings, live_api_available
from deliberate_gm.contracts import load_contract
from deliberate_gm.llm import AnthropicLLM, LLMRequest
from deliberate_gm.prompt import system_blocks

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(not live_api_available(), reason="no ANTHROPIC_API_KEY"),
]

REAL_CONTRACT = Path(__file__).resolve().parents[3] / "contracts" / "gm-tools.json"


def test_the_real_tool_payload_is_accepted() -> None:
    """The regression test for the `strict` 400: all 15 contract tools, as we would send
    them, in one real request. A 400 raises here rather than on ALE-17's first turn."""
    settings = Settings()
    contract = load_contract(REAL_CONTRACT)
    assert len(contract.tools) >= 15

    result = AnthropicLLM(settings).create(
        LLMRequest(
            system=system_blocks(),
            messages=[
                {
                    "role": "user",
                    "content": (
                        "# Turn 1 — preview\n\nThe player asks what they can see. Read the "
                        "world state before you answer anything."
                    ),
                }
            ],
            tools=list(contract.tools),
            stream=True,
        )
    )

    # 200, and the model could actually use the schemas we sent.
    assert result.tool_uses(), f"no tool_use in {result.stop_reason}: {result.content}"
    assert result.tool_uses()[0]["name"] in contract.names()
    assert result.stop_reason == "tool_use"


def test_the_model_settings_are_accepted() -> None:
    """Adaptive thinking, effort inside `output_config`, no `budget_tokens`, no prefill --
    each of those is a 400 if it is wrong, and only a real call can say."""
    result = AnthropicLLM(Settings()).create(
        LLMRequest(
            system=[{"type": "text", "text": "Answer with one word."}],
            messages=[{"role": "user", "content": "Say OK."}],
            tools=[],
            stream=True,
        )
    )
    assert result.text().strip()
    assert result.stop_reason in {"end_turn", "max_tokens"}
