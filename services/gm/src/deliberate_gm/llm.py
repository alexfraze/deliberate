"""The Claude seam.

There are no API credentials on the build machine, so the client sits behind a protocol with
a scripted fake and every test runs against the fake (docs/m1-swarm.md decision 6). The live
path is exercised only when `ANTHROPIC_API_KEY` is present.

Model rules, fixed by decision 7 and easy to get wrong from memory:

* model id is exactly ``claude-opus-5`` -- never a date suffix;
* thinking is ``{"type": "adaptive"}`` -- ``budget_tokens`` is removed on this model and
  returns a 400;
* depth is ``output_config={"effort": ...}`` -- ``effort`` is inside ``output_config``;
* no assistant prefill -- it returns a 400.
"""

from __future__ import annotations

import copy
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from .config import Settings


@dataclass
class LLMRequest:
    """Everything that goes over the wire, as plain data so the fake can assert on it."""

    system: list[dict[str, Any]]
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]]
    stream: bool = False


@dataclass
class LLMResult:
    """A reply, normalized to plain dicts.

    Content blocks stay dicts -- including ``thinking`` blocks with their signature -- so
    they can be echoed straight back into the next request's history unchanged, and so the
    scripted fake produces exactly the shape the real SDK does.
    """

    content: list[dict[str, Any]] = field(default_factory=list)
    stop_reason: str | None = "end_turn"
    usage: dict[str, int] = field(default_factory=dict)

    def text(self) -> str:
        return "".join(
            str(block.get("text", "")) for block in self.content if block.get("type") == "text"
        )

    def tool_uses(self) -> list[dict[str, Any]]:
        return [block for block in self.content if block.get("type") == "tool_use"]


class LLMClient(Protocol):
    def create(self, request: LLMRequest) -> LLMResult: ...


class ScriptedLLM:
    """A fake that replays a script and records what it was asked.

    Entries are either an ``LLMResult`` or a callable taking the request, so a test can
    branch on what the prompt actually contained. Running past the end of the script raises,
    because a silent empty reply would let a broken loop look like a finished one.
    """

    def __init__(self, script: Sequence[LLMResult | Callable[[LLMRequest], LLMResult]]):
        self._script = list(script)
        self._index = 0
        self.requests: list[LLMRequest] = []

    @property
    def exhausted(self) -> bool:
        return self._index >= len(self._script)

    def create(self, request: LLMRequest) -> LLMResult:
        # A snapshot, not the live object: the loop keeps appending to the same message list
        # after the call returns, and a test asserting on "what was sent" must see what was
        # actually sent.
        self.requests.append(copy.deepcopy(request))
        if self.exhausted:
            raise AssertionError(
                f"ScriptedLLM ran out of replies after {self._index} call(s); the loop asked "
                "for one more."
            )
        entry = self._script[self._index]
        self._index += 1
        return entry(request) if callable(entry) else entry


class AnthropicLLM:
    """The live client. Constructed only when a turn actually needs the model."""

    def __init__(self, settings: Settings, client: Any | None = None) -> None:
        self._settings = settings
        if client is None:
            from anthropic import Anthropic

            client = Anthropic()
        self._client = client

    def create(self, request: LLMRequest) -> LLMResult:
        import anthropic

        settings = self._settings
        kwargs: dict[str, Any] = {
            "model": settings.model,
            "system": request.system,
            "messages": request.messages,
            "tools": request.tools,
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": settings.effort},
        }
        try:
            if request.stream:
                # Narration streams: `max_tokens` can be large without risking an HTTP
                # timeout, and `.get_final_message()` gives the accumulated reply.
                kwargs["max_tokens"] = settings.stream_max_tokens
                with self._client.messages.stream(**kwargs) as stream:
                    message = stream.get_final_message()
            else:
                kwargs["max_tokens"] = settings.max_tokens
                message = self._client.messages.create(**kwargs)
        except anthropic.NotFoundError as exc:  # 404 -- usually a bad model id
            raise LLMUnavailable(f"model {settings.model!r} not found: {exc}") from exc
        except anthropic.RateLimitError as exc:  # 429 -- retryable, but not inside a turn
            raise LLMUnavailable(f"rate limited: {exc}") from exc
        except anthropic.APIStatusError as exc:  # any other non-2xx
            raise LLMUnavailable(f"Claude returned HTTP {exc.status_code}") from exc
        except anthropic.APIConnectionError as exc:  # no response at all
            raise LLMUnavailable(f"could not reach Claude: {exc.__class__.__name__}") from exc

        return LLMResult(
            content=[_block_to_dict(block) for block in message.content],
            stop_reason=message.stop_reason,
            usage=_usage_to_dict(message.usage),
        )


class LLMUnavailable(RuntimeError):
    """The model could not be reached or refused the request. The turn cannot continue."""


def _block_to_dict(block: Any) -> dict[str, Any]:
    if isinstance(block, dict):
        return block
    dump = getattr(block, "model_dump", None)
    if dump is not None:
        return dict(dump())
    return dict(block)


def _usage_to_dict(usage: Any) -> dict[str, int]:
    if usage is None:
        return {}
    dump = getattr(usage, "model_dump", None)
    raw: Iterable[tuple[str, Any]] = (dump() if dump else dict(usage)).items()
    return {key: int(value) for key, value in raw if isinstance(value, int)}
