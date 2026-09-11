"""The client for the one door into the engine."""

from __future__ import annotations

import httpx
import pytest

from deliberate_gm.engine_client import HttpEngineClient
from deliberate_gm.models import GmToolCall


def make_call() -> GmToolCall:
    return GmToolCall(
        session="room-1",
        turn=2,
        engine_token="engine:preview:2",
        call_id="toolu_1",
        tool="attack",
        input={"attacker": "pc:ari", "target": "npc:gorm", "ability": "sword"},
    )


def client_for(handler) -> HttpEngineClient:  # noqa: ANN001
    transport = httpx.MockTransport(handler)
    return HttpEngineClient("http://node.test", client=httpx.Client(transport=transport))


def test_the_call_goes_to_gm_tool_with_the_engine_token() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = httpx.Response(200).json if False else request.read().decode()
        return httpx.Response(200, json={"ok": True, "kind": "mutation", "diff": []})

    result = client_for(handler).call(make_call())
    assert seen["url"] == "http://node.test/gm/tool"
    assert "engine:preview:2" in str(seen["body"])
    assert result.ok is True


def test_a_verdict_round_trips() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "ok": False,
                "kind": "mutation",
                "reason": "Gorm is four tiles away; your reach is one.",
                "diff": [],
            },
        )

    result = client_for(handler).call(make_call())
    assert result.ok is False
    assert "four tiles away" in (result.reason or "")


@pytest.mark.parametrize(
    ("handler", "expected"),
    [
        (lambda request: httpx.Response(500, text="boom"), "HTTP 500"),
        (lambda request: httpx.Response(200, text="not json"), "non-JSON"),
        (lambda request: httpx.Response(200, json=[1, 2]), "non-object"),
    ],
)
def test_a_broken_engine_becomes_a_rejection(handler, expected) -> None:  # noqa: ANN001
    result = client_for(handler).call(make_call())
    assert result.ok is False
    assert expected in (result.reason or "")


def test_a_transport_failure_becomes_a_rejection() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    result = client_for(handler).call(make_call())
    assert result.ok is False
    assert "engine unreachable" in (result.reason or "")
