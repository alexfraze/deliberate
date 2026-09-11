"""The `/turn` surface, end to end against the stub engine and the scripted fake.

This is ALE-14's acceptance: a `/turn` request answered with a tool-call trace.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from deliberate_gm.app import create_app
from deliberate_gm.llm import ScriptedLLM

from .conftest import call, say


def test_turn_answers_with_a_tool_call_trace(settings, engine) -> None:
    engine.answer("get_state", {"entities": ["pc:ari", "npc:gorm"]})
    engine.accept("say", diff=[{"type": "DialogueLine", "speaker": "npc:gorm", "text": "Hold."}])
    llm = ScriptedLLM(
        [
            call(("get_state", {"scope": "visible"})),
            call(("say", {"npc_id": "npc:gorm", "text": "Hold.", "to": "pc:ari"})),
            say("Gorm plants his boots in the mud and lifts a hand."),
        ]
    )
    client = TestClient(create_app(settings, llm=llm, engine=engine))

    response = client.post(
        "/turn",
        json={
            "session": "room-1",
            "turn": 4,
            "phase": "preview",
            "engine_token": "engine:preview:4",
            "state": {"entities": ["pc:ari", "npc:gorm"]},
            "player_intent": {"kind": "move", "entity": "pc:ari", "to": {"x": 2, "y": 2}},
        },
    )
    assert response.status_code == 200
    body = response.json()

    assert body["session"] == "room-1"
    assert body["turn"] == 4
    assert [record["tool"] for record in body["trace"]] == ["get_state", "say"]
    assert body["trace"][1]["diff"][0]["type"] == "DialogueLine"
    assert body["narration"].startswith("Gorm plants")
    assert body["prompt_tokens_estimate"] > 0
    # The engine token is echoed on every call so Node knows which engine to act on.
    assert {c.engine_token for c in engine.calls} == {"engine:preview:4"}


def test_healthz_reports_the_model_and_the_contract(settings, engine) -> None:
    client = TestClient(create_app(settings, llm=ScriptedLLM([]), engine=engine))
    body = client.get("/healthz").json()
    assert body["model"] == "claude-opus-5"
    assert body["contract"] == "loaded"
    assert "attack" in body["tools"]


def test_turn_without_credentials_fails_loudly(settings, engine, monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    client = TestClient(create_app(settings, engine=engine))
    response = client.post("/turn", json={"session": "s", "turn": 1})
    assert response.status_code == 503
    assert "ANTHROPIC_API_KEY" in response.json()["detail"]


def test_missing_contract_is_a_503_naming_the_owner(settings, engine, tmp_path) -> None:
    broken = settings.__class__(
        tools_path=tmp_path / "absent.json", engine_url="stub", python_tool_enabled=False
    )
    client = TestClient(create_app(broken, llm=ScriptedLLM([]), engine=engine))
    response = client.post("/turn", json={"session": "s", "turn": 1})
    assert response.status_code == 503
    assert "ALE-31" in response.json()["detail"]
