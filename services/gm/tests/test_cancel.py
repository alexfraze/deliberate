"""`POST /cancel` — stopping a turn the player abandoned (ALE-52).

The claim this file is here to keep honest is **"an abandoned call stops costing money"**, and the
part of that claim which lives in this service is: a set cancel flag stops the loop before it makes
another model call, and stops the *current* one mid-stream rather than reading it to the end. The
mid-stream half is asserted through a fake stream that counts how many events it was asked for --
which is exactly the number Anthropic would have been asked to generate.

The other half of the claim — that the live stream really does stop billing when the `with` block is
left — is not a property of this code and cannot be asserted from a fake. It is in the PR.
"""

from __future__ import annotations

import threading
from typing import Any

from fastapi.testclient import TestClient

from deliberate_gm.agent import GmAgent
from deliberate_gm.app import LIVE_ENGINE_TOKEN, create_app
from deliberate_gm.llm import ABANDONED, AnthropicLLM, LLMRequest, LLMResult, ScriptedLLM

from .conftest import call, say

TURN = {
    "session": "room-1",
    "turn": 4,
    "phase": "preview",
    "engine_token": "preview-7",
    "state": {"entities": ["pc:ari", "npc:gorm"]},
    "entities": ["pc:ari", "npc:gorm"],
    "player_intent": {"kind": "move", "entity": "pc:ari", "to": {"x": 2, "y": 2}},
    "player_text": None,
    "memory": {},
}


def test_cancelling_a_token_nobody_is_running_is_not_an_error(settings, engine) -> None:
    client = TestClient(create_app(settings, llm=ScriptedLLM([]), engine=engine))
    response = client.post("/cancel", json={"engine_token": "preview-99"})
    assert response.status_code == 200
    # The turn may simply have finished between the key press and this request. Nothing is wrong.
    assert response.json() == {"stopping": False}


def test_a_turn_on_the_live_engine_is_never_registered_as_cancellable(settings, engine) -> None:
    """The safety line, from this end.

    A turn on the live token commits its calls as they land, so there is no moment at which
    stopping it is safe: it would leave the turn half-applied with nothing to roll back. It is
    therefore never registered, and `/cancel` has no handle on it however it is asked.
    """
    seen: list[bool] = []

    def watcher(request: LLMRequest) -> LLMResult:
        cancelled = request.cancelled
        # The turn is mid-flight right now; cancelling it from here must not take hold.
        client.post("/cancel", json={"engine_token": LIVE_ENGINE_TOKEN})
        seen.append(cancelled() if cancelled else False)
        return say("The gate guard shifts his weight.")

    client = TestClient(
        create_app(settings, llm=ScriptedLLM([watcher]), engine=engine),
        # The nested request needs its own portal; `TestClient` is re-entrant for this.
        raise_server_exceptions=True,
    )
    response = client.post("/turn", json={**TURN, "engine_token": LIVE_ENGINE_TOKEN})
    assert response.status_code == 200
    assert seen == [False]
    assert response.json()["stop_reason"] == "end_turn"


def test_a_cancelled_turn_stops_before_it_buys_another_model_call(settings, engine) -> None:
    """The between-steps half: a turn abandoned while the engine was answering buys nothing more."""
    engine.answer("get_state", {"entities": ["pc:ari"]})
    stop = threading.Event()
    stop.set()
    agent = GmAgent(
        llm=ScriptedLLM([call(("get_state", {"scope": "visible"}))]),
        engine=engine,
        contract=__import__("deliberate_gm.contracts", fromlist=["load_contract"]).load_contract(
            settings.tools_path
        ),
        settings=settings,
        cancelled=stop.is_set,
    )
    from deliberate_gm.models import TurnRequest

    response = agent.run_turn(TurnRequest(**TURN))
    assert response.stop_reason == ABANDONED
    # Not one call. The flag was set before the first step, so the cheapest possible abandonment
    # is the one that spends nothing at all.
    assert response.trace == []
    assert response.usage.output_tokens == 0


def test_cancel_stops_the_stream_instead_of_reading_it_to_the_end(settings) -> None:
    """The half that is the money: the stream is *left*, not consumed.

    `FakeStream` counts the events it was asked for. A turn that reads to the end asks for all of
    them -- every one of which the model had to generate and be charged for. A cancelled turn
    stops at the event after the flag was set, and closing the block is what tells Claude to stop.
    """

    class FakeMessage:
        usage = {"input_tokens": 120, "output_tokens": 7}
        content: list[Any] = [{"type": "text", "text": "partial"}]
        stop_reason = "end_turn"

    class FakeStream:
        def __init__(self, events: int) -> None:
            self.events = events
            self.asked = 0
            self.closed = False

        def __enter__(self) -> FakeStream:
            return self

        def __exit__(self, *_: object) -> None:
            self.closed = True

        def __iter__(self) -> Any:
            for _ in range(self.events):
                self.asked += 1
                yield object()

        @property
        def current_message_snapshot(self) -> FakeMessage:
            return FakeMessage()

        def get_final_message(self) -> FakeMessage:
            return FakeMessage()

    stream = FakeStream(events=50)

    class FakeMessages:
        def stream(self, **_: object) -> FakeStream:
            return stream

    class FakeClient:
        messages = FakeMessages()

    stop = threading.Event()
    llm = AnthropicLLM(settings, client=FakeClient())

    # Abandoned after the third event.
    def cancelled() -> bool:
        if stream.asked >= 3:
            stop.set()
        return stop.is_set()

    result = llm.create(
        LLMRequest(system=[], messages=[], tools=[], stream=True, cancelled=cancelled)
    )
    assert result.abandoned is True
    assert result.stop_reason == ABANDONED
    # Three events, not fifty. The rest were never generated, which is the whole point.
    assert stream.asked == 3
    assert stream.closed is True
    # What it had cost by then, for the log. It is not returned to Node -- Node aborted the
    # request that would have carried it -- and it is a fraction of a finished turn.
    assert result.usage == {"input_tokens": 120, "output_tokens": 7}


def test_an_uncancellable_call_reads_the_stream_as_before(settings) -> None:
    """No `cancelled` callable, no behaviour change: `get_final_message` as it always was."""

    class FakeMessage:
        usage = {"input_tokens": 1, "output_tokens": 2}
        content: list[Any] = [{"type": "text", "text": "whole"}]
        stop_reason = "end_turn"

    class FakeStream:
        def __init__(self) -> None:
            self.iterated = False

        def __enter__(self) -> FakeStream:
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def __iter__(self) -> Any:
            self.iterated = True
            return iter(())

        def get_final_message(self) -> FakeMessage:
            return FakeMessage()

    stream = FakeStream()

    class FakeClient:
        messages = type("M", (), {"stream": lambda _self, **_: stream})()

    result = AnthropicLLM(settings, client=FakeClient()).create(
        LLMRequest(system=[], messages=[], tools=[], stream=True)
    )
    assert result.stop_reason == "end_turn"
    assert result.abandoned is False
    assert stream.iterated is False
