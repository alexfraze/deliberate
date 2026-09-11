"""What we actually send to Claude.

There are no credentials on this machine, so the live path cannot be exercised here. What
*can* be pinned without one is the shape of the request and the names of the parameters it
uses, checked against the installed SDK. Several of these settings are things a stale memory
gets wrong -- `budget_tokens`, `effort` at the top level, a date-suffixed model id -- and each
one is a 400 that would only show up on the first real call. ALE-17 is that first real call;
these tests are what stop it being the first time anyone finds out.
"""

from __future__ import annotations

import inspect
import re
from typing import Any

import anthropic
import httpx2
import pytest
from anthropic.resources.messages import Messages

from deliberate_gm.config import DEFAULT_MODEL, Settings
from deliberate_gm.llm import AnthropicLLM, LLMRequest, LLMUnavailable

REQUEST = LLMRequest(
    system=[{"type": "text", "text": "s", "cache_control": {"type": "ephemeral"}}],
    messages=[{"role": "user", "content": "hello"}],
    tools=[{"name": "get_state", "input_schema": {"type": "object"}}],
)


class FakeMessage:
    def __init__(self) -> None:
        self.content = [_Block({"type": "text", "text": "hi"})]
        self.stop_reason = "end_turn"
        self.usage = _Block({"input_tokens": 10, "output_tokens": 2, "speed": None})


class _Block:
    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    def model_dump(self) -> dict[str, Any]:
        return dict(self._data)


class _Stream:
    def __init__(self, recorder: dict[str, Any], kwargs: dict[str, Any]) -> None:
        self._recorder = recorder
        self._kwargs = kwargs

    def __enter__(self) -> _Stream:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def get_final_message(self) -> FakeMessage:
        self._recorder["final_message_called"] = True
        return FakeMessage()


class FakeMessages:
    def __init__(self, recorder: dict[str, Any], raises: Exception | None = None) -> None:
        self._recorder = recorder
        self._raises = raises

    def create(self, **kwargs: Any) -> FakeMessage:
        self._recorder["call"] = ("create", kwargs)
        if self._raises:
            raise self._raises
        return FakeMessage()

    def stream(self, **kwargs: Any) -> _Stream:
        self._recorder["call"] = ("stream", kwargs)
        if self._raises:
            raise self._raises
        return _Stream(self._recorder, kwargs)


class FakeClient:
    def __init__(self, recorder: dict[str, Any], raises: Exception | None = None) -> None:
        self.messages = FakeMessages(recorder, raises)


def send(*, stream: bool, settings: Settings | None = None) -> dict[str, Any]:
    recorder: dict[str, Any] = {}
    llm = AnthropicLLM(settings or Settings(), client=FakeClient(recorder))
    llm.create(LLMRequest(REQUEST.system, REQUEST.messages, REQUEST.tools, stream=stream))
    method, kwargs = recorder["call"]
    return {"method": method, "kwargs": kwargs, "recorder": recorder}


def test_the_request_carries_what_this_model_needs() -> None:
    kwargs = send(stream=False)["kwargs"]
    assert kwargs["model"] == "claude-opus-5"
    # Adaptive thinking, and depth inside output_config -- not a top-level `effort`.
    assert kwargs["thinking"] == {"type": "adaptive"}
    assert kwargs["output_config"] == {"effort": "high"}
    assert "effort" not in kwargs
    assert kwargs["tools"] == REQUEST.tools
    assert kwargs["system"] == REQUEST.system


def test_budget_tokens_is_never_sent() -> None:
    """Removed on this model: sending it is a 400, not a soft fallback."""
    for stream in (False, True):
        kwargs = send(stream=stream)["kwargs"]
        assert "budget_tokens" not in kwargs
        assert "budget_tokens" not in str(kwargs["thinking"])


def test_the_model_id_carries_no_date_suffix() -> None:
    """`claude-opus-5-20260101` and friends are the shape a stale memory produces, and the
    API answers them with a 404."""
    assert DEFAULT_MODEL == "claude-opus-5"
    assert re.search(r"-\d{6,}$", DEFAULT_MODEL) is None


def test_streaming_uses_the_helper_and_the_accumulated_message() -> None:
    sent = send(stream=True)
    assert sent["method"] == "stream"
    assert sent["recorder"]["final_message_called"] is True
    # Streaming is what makes the larger ceiling safe against HTTP timeouts.
    assert sent["kwargs"]["max_tokens"] == 64_000


def test_the_non_streaming_ceiling_stays_under_the_sdk_timeout() -> None:
    sent = send(stream=False)
    assert sent["method"] == "create"
    assert sent["kwargs"]["max_tokens"] == 16_000


def test_blocks_come_back_as_plain_dicts() -> None:
    recorder: dict[str, Any] = {}
    llm = AnthropicLLM(Settings(), client=FakeClient(recorder))
    result = llm.create(REQUEST)
    # Plain dicts so they can be echoed straight back into the next request's history --
    # thinking blocks included, signature intact.
    assert result.content == [{"type": "text", "text": "hi"}]
    assert result.usage == {"input_tokens": 10, "output_tokens": 2}
    assert result.text() == "hi"


def response(status: int) -> httpx2.Response:
    return httpx2.Response(status, request=httpx2.Request("POST", "https://api.anthropic.com"))


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (anthropic.NotFoundError("no such model", response=response(404), body=None), "not found"),
        (anthropic.RateLimitError("slow down", response=response(429), body=None), "rate limited"),
        (anthropic.APIStatusError("boom", response=response(503), body=None), "HTTP 503"),
        (
            anthropic.APIConnectionError(request=httpx2.Request("POST", "https://x")),
            "could not reach Claude",
        ),
    ],
    ids=["404", "429", "5xx", "network"],
)
def test_typed_errors_become_one_turn_level_failure(error: Exception, expected: str) -> None:
    """Caught most-specific-first and never by matching on the message text."""
    llm = AnthropicLLM(Settings(), client=FakeClient({}, raises=error))
    with pytest.raises(LLMUnavailable, match=expected):
        llm.create(REQUEST)


def test_every_parameter_we_send_exists_on_the_installed_sdk() -> None:
    """Catches an SDK rename at test time rather than on ALE-17's first real call."""
    parameters = set(inspect.signature(Messages.create).parameters)
    for name in ("model", "system", "messages", "tools", "thinking", "output_config", "max_tokens"):
        assert name in parameters, name
    assert hasattr(Messages, "stream")
    for name in ("NotFoundError", "RateLimitError", "APIStatusError", "APIConnectionError"):
        assert hasattr(anthropic, name), name
