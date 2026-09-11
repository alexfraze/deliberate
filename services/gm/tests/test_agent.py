"""The agent loop, against the scripted fake and the stub engine."""

from __future__ import annotations

import json

from deliberate_gm.agent import BATCH_STOPPED, GmAgent, estimate_tokens, trim_messages
from deliberate_gm.llm import LLMResult, ScriptedLLM
from deliberate_gm.prompt.system import SYSTEM_PROMPT

from .conftest import call, say


def build(llm, engine, tools, settings, **kwargs):
    return GmAgent(llm=llm, engine=engine, tools=tools, settings=settings, **kwargs)


def test_turn_produces_a_trace_of_engine_verdicts(engine, tools, settings, turn_request) -> None:
    engine.answer("legal_actions", ["attack", "move"])
    engine.accept("attack", diff=[{"type": "DamageApplied", "entity": "npc:gorm", "amount": 7}])
    llm = ScriptedLLM(
        [
            call(("legal_actions", {"entity_id": "pc:ari"})),
            call(("attack", {"attacker": "pc:ari", "target": "npc:gorm", "ability": "sword"})),
            say("Ari's blade finds the gap in Gorm's guard."),
        ]
    )

    response = build(llm, engine, tools, settings).run_turn(turn_request)

    assert [record.tool for record in response.trace] == ["legal_actions", "attack"]
    assert [record.ok for record in response.trace] == [True, True]
    assert response.trace[1].diff[0]["type"] == "DamageApplied"
    assert response.narration.startswith("Ari's blade")
    assert response.stop_reason == "end_turn"
    assert llm.exhausted


def test_every_tool_use_block_gets_a_result(engine, tools, settings, turn_request) -> None:
    engine.answer("legal_actions", [])
    engine.answer("recall", "nothing")
    llm = ScriptedLLM(
        [
            call(("legal_actions", {"entity_id": "pc:ari"}), ("recall", {"topic": "gorm"})),
            say("done"),
        ]
    )
    build(llm, engine, tools, settings).run_turn(turn_request)

    # The second request carries the assistant turn plus one user message holding BOTH
    # results. Splitting them teaches the model to stop batching.
    results_message = llm.requests[1].messages[-1]
    assert results_message["role"] == "user"
    assert [block["type"] for block in results_message["content"]] == [
        "tool_result",
        "tool_result",
    ]


def test_a_rejection_stops_the_rest_of_the_batch(engine, tools, settings, turn_request) -> None:
    engine.reject("move", "that tile is occupied")
    llm = ScriptedLLM(
        [
            call(
                ("move", {"entity_id": "pc:ari", "to": {"x": 3, "y": 4}}),
                ("attack", {"attacker": "pc:ari", "target": "npc:gorm", "ability": "sword"}),
            ),
            say("Ari steps up, and the way is blocked."),
        ]
    )
    response = build(llm, engine, tools, settings).run_turn(turn_request)

    move, attack = response.trace
    assert move.ok is False and move.reason == "that tile is occupied"
    assert attack.executed is False and attack.reason == BATCH_STOPPED
    # The attack never reached the engine.
    assert [c.tool for c in engine.calls] == ["move"]
    # But the model still got a result for it, marked as an error.
    blocks = llm.requests[1].messages[-1]["content"]
    assert blocks[0]["is_error"] is True
    assert blocks[1]["is_error"] is True


def test_a_rejected_call_is_reported_as_an_error_result(
    engine, tools, settings, turn_request
) -> None:
    engine.reject("attack", "out of range")
    llm = ScriptedLLM(
        [
            call(("attack", {"attacker": "pc:ari", "target": "npc:gorm", "ability": "sword"})),
            say("Ari's swing falls short."),
        ]
    )
    build(llm, engine, tools, settings).run_turn(turn_request)

    block = llm.requests[1].messages[-1]["content"][0]
    assert block["is_error"] is True
    assert json.loads(block["content"]) == {"ok": False, "reason": "out of range"}


def test_an_unknown_tool_is_refused_without_reaching_the_engine(
    engine, tools, settings, turn_request
) -> None:
    llm = ScriptedLLM([call(("delete_everything", {})), say("nothing happens")])
    response = build(llm, engine, tools, settings).run_turn(turn_request)

    assert response.trace[0].ok is False
    assert "not in the GM tool contract" in (response.trace[0].reason or "")
    assert engine.calls == []


def test_engine_failure_is_a_verdict_not_an_exception(tools, settings, turn_request) -> None:
    class DeadEngine:
        def call(self, call):  # noqa: ANN001, ANN201
            from deliberate_gm.models import GmToolResult

            return GmToolResult(ok=False, reason="engine unreachable: ConnectError")

    llm = ScriptedLLM([call(("end_turn", {"entity_id": "pc:ari"})), say("The moment passes.")])
    response = build(llm, DeadEngine(), tools, settings).run_turn(turn_request)
    assert response.trace[0].ok is False
    assert response.narration == "The moment passes."


def test_tool_input_arriving_as_a_json_string_is_parsed(
    engine, tools, settings, turn_request
) -> None:
    engine.accept("set_flag")
    llm = ScriptedLLM(
        [
            LLMResult(
                content=[
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "set_flag",
                        "input": '{"key": "gate", "value": "open"}',
                    }
                ],
                stop_reason="tool_use",
            ),
            say("The gate is open."),
        ]
    )
    response = build(llm, engine, tools, settings).run_turn(turn_request)
    assert engine.calls[0].input == {"key": "gate", "value": "open"}
    assert response.trace[0].input == {"key": "gate", "value": "open"}


def test_the_loop_stops_at_max_tool_steps(engine, tools, settings, turn_request) -> None:
    engine.answer("recall", "nothing")
    llm = ScriptedLLM([call(("recall", {"topic": "x"})) for _ in range(3)])
    request = turn_request.model_copy(update={"max_tool_steps": 3})

    response = build(llm, engine, tools, settings).run_turn(request)
    assert response.stop_reason == "max_tool_steps"
    assert len(response.trace) == 3
    assert llm.exhausted


def test_thinking_blocks_are_echoed_back_unchanged(engine, tools, settings, turn_request) -> None:
    thinking = {"type": "thinking", "thinking": "…", "signature": "sig-abc"}
    engine.answer("recall", "nothing")
    llm = ScriptedLLM(
        [
            LLMResult(
                content=[
                    thinking,
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "recall",
                        "input": {"topic": "x"},
                    },
                ],
                stop_reason="tool_use",
            ),
            say("ok"),
        ]
    )
    build(llm, engine, tools, settings).run_turn(turn_request)
    assert llm.requests[1].messages[1]["content"][0] == thinking


def test_the_prompt_prefix_is_stable_across_turns(engine, tools, settings, turn_request) -> None:
    engine.answer("recall", "nothing")
    llm = ScriptedLLM([call(("recall", {"topic": "x"})), say("ok")])
    build(llm, engine, tools, settings).run_turn(turn_request)

    first, second = llm.requests[0], llm.requests[1]
    assert first.system == second.system
    assert first.tools == second.tools
    assert first.system[0]["text"] == SYSTEM_PROMPT
    assert first.system[0]["cache_control"] == {"type": "ephemeral"}


def test_trim_keeps_the_anchor_and_drops_whole_exchanges() -> None:
    messages = [{"role": "user", "content": "anchor"}]
    for index in range(6):
        messages.append(
            {
                "role": "assistant",
                "content": [{"type": "tool_use", "id": f"t{index}", "name": "recall", "input": {}}],
            }
        )
        messages.append(
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": f"t{index}", "content": "x" * 400}
                ],
            }
        )

    trimmed = trim_messages(messages, budget=300)
    assert trimmed[0] == messages[0]
    assert estimate_tokens(trimmed) <= 300 or len(trimmed) == 1
    # No orphaned tool_result: every tool_use_id present has its tool_use still there.
    used = {
        block["id"]
        for message in trimmed
        if message["role"] == "assistant"
        for block in message["content"]
    }
    answered = {
        block["tool_use_id"]
        for message in trimmed
        if message["role"] == "user" and isinstance(message["content"], list)
        for block in message["content"]
    }
    assert answered <= used
