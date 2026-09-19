"""NPC code brains (ALE-37): what `save_policy` refuses, and what `/policy` does with what it kept.

Two guarantees are under test, and they are the two the issue is judged on:

* **Nothing reaches the skill cache that has not already run.** `save_policy` smoke-runs every
  program in the sandbox against a dry-run `gm_tool` before it will hand it back, so a program
  that does not parse, raises, hangs, or calls nothing is refused at the moment it is written —
  with a reason the model can act on, and never on the critical path of a combat turn.
* **A running policy is not privileged.** Its only way out is the same `/gm/tool` door, its calls
  come back with the same verdicts, and the leakage guard still stands in front of them.
"""

from __future__ import annotations

from typing import Any

from deliberate_gm.models import GmToolResult, PolicyRequest, TurnRequest
from deliberate_gm.policy import (
    CALL_LIMIT,
    LEAK_REFUSED,
    MAX_POLICY_CALLS,
    PolicyDraft,
    make_save_policy_tool,
    run_policy,
)
from deliberate_gm.prompt import SYSTEM_PROMPT
from deliberate_gm.stub_engine import StubEngine

STATE: dict[str, Any] = {
    "acting": "npc:gorm",
    "entities": [
        {"id": "npc:gorm", "faction": "raiders", "hp": 9, "conditions": []},
        {"id": "pc:ari", "faction": "party", "hp": 12, "conditions": []},
    ],
}

#: What a real generated policy looks like: read the board, decide, act, end the turn.
HOLD_THE_LINE = """
me = state["acting"]
foes = [e for e in state["entities"] if e["faction"] != "raiders" and "dead" not in e["conditions"]]
if foes:
    target = min(foes, key=lambda e: e["hp"])
    gm_tool("attack", attacker=me, target=target["id"])
gm_tool("end_turn", entity_id=me)
"""


def request(**overrides: Any) -> TurnRequest:
    base: dict[str, Any] = {
        "session": "room-1",
        "turn": 4,
        "phase": "resolve",
        "engine_token": None,
        "state": STATE,
        "entities": ["npc:gorm", "pc:ari"],
    }
    base.update(overrides)
    return TurnRequest(**base)


def never_nested(tool: str, payload: dict[str, Any]) -> GmToolResult:
    raise AssertionError(f"save_policy must not reach the engine (tried {tool!r})")


def save(code: str, *, note: str = "n") -> tuple[GmToolResult, PolicyDraft]:
    draft = PolicyDraft()
    tool = make_save_policy_tool(draft, timeout_seconds=5)
    return tool(request(), {"code": code, "note": note}, never_nested), draft


# -- what save_policy keeps ------------------------------------------------------------------


def test_a_working_policy_is_saved_and_its_dry_run_reported() -> None:
    verdict, draft = save(HOLD_THE_LINE)
    assert verdict.ok
    assert draft.code == HOLD_THE_LINE
    # The model is told what its program would have done, so it can tell a policy that acts from
    # one that merely runs. Nothing here reached the engine: `never_nested` would have raised.
    calls = verdict.result["would_call"]
    assert [entry["tool"] for entry in calls] == ["attack", "end_turn"]
    assert calls[0]["input"] == {"attacker": "npc:gorm", "target": "pc:ari"}


def test_a_policy_that_does_not_parse_is_refused_with_the_line() -> None:
    verdict, draft = save("if True\n    gm_tool('end_turn', entity_id='x')")
    assert not verdict.ok
    assert "does not parse" in (verdict.reason or "")
    assert draft.code is None


def test_a_policy_that_raises_is_refused_before_it_is_ever_cached() -> None:
    verdict, draft = save("me = state['acting']\nboom = state['no such key']")
    assert not verdict.ok
    assert "did not run" in (verdict.reason or "")
    assert draft.code is None


def test_a_policy_that_hangs_is_killed_and_refused() -> None:
    # The sandbox's own wall-clock timeout, on the generation path rather than the turn path. A
    # program that cannot finish here is a program that would have burnt the resolve budget every
    # turn for the rest of the encounter.
    draft = PolicyDraft()
    tool = make_save_policy_tool(draft, timeout_seconds=1)
    verdict = tool(request(), {"code": "while True:\n    pass", "note": "n"}, never_nested)
    assert not verdict.ok
    assert "did not run" in (verdict.reason or "")
    assert draft.code is None


def test_a_policy_that_calls_nothing_is_refused() -> None:
    # It would run forever and take no turns, and the server would quietly end every turn for it.
    verdict, draft = save("result = len(state['entities'])")
    assert not verdict.ok
    assert "called no GM tool" in (verdict.reason or "")
    assert draft.code is None


def test_an_escape_attempt_fails_inside_the_sandbox() -> None:
    verdict, draft = save("import os\ngm_tool('end_turn', entity_id='x')")
    assert not verdict.ok
    assert "not allowed in the sandbox" in (verdict.reason or "")
    assert draft.code is None


def test_a_runaway_policy_is_capped_rather_than_saved() -> None:
    # Past the cap the dry run starts refusing, so a program that never reads a verdict spins to
    # the timeout and a program that does gets told why. Either way it is not saved as it stands.
    verdict, _ = save(
        "for i in range(100):\n"
        "    v = gm_tool('attack', attacker='a', target='b')\n"
        "    if not v['ok']:\n"
        "        break\n"
        "result = v['reason']"
    )
    assert verdict.ok
    assert len(verdict.result["would_call"]) == MAX_POLICY_CALLS


# -- what running one does -------------------------------------------------------------------


def test_running_a_policy_puts_every_call_through_the_engine() -> None:
    engine = StubEngine(state=STATE)
    engine.accept("attack", diff=[{"type": "Damaged", "entity": "pc:ari", "amount": 3}])
    engine.accept("end_turn")

    response = run_policy(
        PolicyRequest(
            session="room-1",
            turn=4,
            engine_token="live",
            state=STATE,
            acting="npc:gorm",
            code=HOLD_THE_LINE,
        ),
        engine=engine,
        timeout_seconds=5,
    )

    assert response.ok
    assert [call.tool for call in engine.calls] == ["attack", "end_turn"]
    # The token Node named is echoed on every call, exactly as `/turn` echoes it. A policy that
    # aimed itself at a different engine would be aiming at a preview clone that is already gone.
    assert {call.engine_token for call in engine.calls} == {"live"}
    assert [record.ok for record in response.trace] == [True, True]
    assert response.trace[0].diff


def test_a_refused_call_is_a_verdict_the_policy_can_read_not_a_failure() -> None:
    # The batch-stop discipline is for the *model*, which planned a chain on an assumption. A
    # policy is code: it can read the refusal and do something else, which is the whole reason
    # for writing behaviour as a program. So a refusal does not stop it — the call cap does.
    engine = StubEngine(state=STATE)
    engine.reject("attack", "npc:gorm has no attack left this turn")
    engine.accept("end_turn")

    response = run_policy(
        PolicyRequest(
            session="room-1",
            turn=4,
            state=STATE,
            acting="npc:gorm",
            code=(
                "me = state['acting']\n"
                "v = gm_tool('attack', attacker=me, target='pc:ari')\n"
                "if not v['ok']:\n"
                "    gm_tool('say', npc_id=me, text='Another time.')\n"
                "gm_tool('end_turn', entity_id=me)\n"
            ),
        ),
        engine=engine,
        timeout_seconds=5,
    )

    assert response.ok
    assert [call.tool for call in engine.calls] == ["attack", "say", "end_turn"]
    assert [record.ok for record in response.trace] == [False, False, True]
    assert "no attack left" in (response.trace[0].reason or "")


def test_a_policy_that_crashes_reports_ok_false_and_what_it_did() -> None:
    engine = StubEngine(state=STATE)
    engine.accept("say")
    response = run_policy(
        PolicyRequest(
            session="room-1",
            turn=4,
            state=STATE,
            acting="npc:gorm",
            code="gm_tool('say', npc_id='npc:gorm', text='Hah!')\nraise ValueError('nope')",
        ),
        engine=engine,
        timeout_seconds=5,
    )
    # `ok: False` is Node's cue to retire the policy and ask the model. The call that did land is
    # still on the trace, because it landed: the engine accepted it and the world moved.
    assert not response.ok
    assert "ValueError" in (response.error or "")
    assert [record.tool for record in response.trace] == ["say"]


def test_a_policy_cannot_carry_the_prompt_to_the_player() -> None:
    # The leakage guard stands in front of this path too. It has to: an NPC's `say` line reaches
    # the player exactly like narration does, and the engine has no idea what this prompt says.
    leak = " ".join(SYSTEM_PROMPT.split()[:20])
    engine = StubEngine(state=STATE)
    engine.accept("say")
    response = run_policy(
        PolicyRequest(
            session="room-1",
            turn=4,
            state=STATE,
            acting="npc:gorm",
            code=f"gm_tool('say', npc_id='npc:gorm', text={leak!r})",
        ),
        engine=engine,
        timeout_seconds=5,
    )
    assert engine.calls == []
    assert response.trace[0].reason == LEAK_REFUSED
    assert response.trace[0].executed is False


def test_a_policy_cannot_spend_the_whole_encounter_in_one_turn() -> None:
    engine = StubEngine(state=STATE)
    engine.accept("say")
    response = run_policy(
        PolicyRequest(
            session="room-1",
            turn=4,
            state=STATE,
            acting="npc:gorm",
            code="for i in range(40):\n    gm_tool('say', npc_id='npc:gorm', text='ha')",
        ),
        engine=engine,
        timeout_seconds=5,
    )
    assert len(engine.calls) == MAX_POLICY_CALLS
    assert response.trace[-1].reason == CALL_LIMIT
    assert response.trace[-1].executed is False


# -- the ambient world turn (ALE-41) ---------------------------------------------------------


def _ambient_request(**kwargs: Any) -> TurnRequest:
    return TurnRequest(session="s", turn=4, phase="ambient", state=STATE, **kwargs)


def test_the_ambient_task_line_does_not_claim_initiative_is_running() -> None:
    """The reason `ambient` is a phase and not a flag on `resolve`.

    `resolve`'s task line opens "Initiative is running", which on a quiet turn is simply false,
    and an NPC told it is in a fight behaves like one. This is the whole content of the protocol
    addition, so it is worth one assertion.
    """
    from deliberate_gm.prompt.turn import PHASE_TASK, build_user_message

    assert "Initiative is running" in PHASE_TASK["resolve"]
    assert "No encounter is running" in PHASE_TASK["ambient"]
    # And the one instruction that stops an ambient NPC earning a guaranteed refusal.
    assert "Do not call `end_turn`" in PHASE_TASK["ambient"]

    content = build_user_message(_ambient_request())["content"]
    assert content.endswith("## Your task\n" + PHASE_TASK["ambient"])


def test_an_ambient_policy_is_asked_for_in_its_own_words() -> None:
    """Both halves of ALE-37's generation prompt exist, and neither leaks into the other.

    A combat policy is asked for as "how it fights it"; an idle one as "how it spends them". The
    same string for both would tell a merchant at a stall to write a battle plan.
    """
    from deliberate_gm.prompt.turn import AMBIENT_POLICY_TASK, POLICY_TASK, build_user_message

    ambient = build_user_message(_ambient_request(want_policy=True))["content"]
    assert ambient.endswith(AMBIENT_POLICY_TASK)
    assert POLICY_TASK not in ambient

    combat = build_user_message(
        TurnRequest(session="s", turn=4, phase="resolve", state=STATE, want_policy=True)
    )["content"]
    assert combat.endswith(POLICY_TASK)
    assert AMBIENT_POLICY_TASK not in combat

    # An ambient turn that was not asked for a policy gets the plain task line and nothing more.
    assert AMBIENT_POLICY_TASK not in build_user_message(_ambient_request())["content"]


def test_a_policy_runs_the_same_way_whatever_phase_wrote_it() -> None:
    """`POST /policy` has no phase: a program is a program, and the engine validates its calls
    either way. This is what lets the ambient turn reuse ALE-37 whole rather than copy it."""
    engine = StubEngine()
    engine.accept("say")
    result = run_policy(
        PolicyRequest(
            session="s",
            turn=4,
            acting="npc:gorm",
            # The cue is ordinary state, so a policy can read why it was woken.
            state={**STATE, "cue": "the player has come close enough to touch"},
            code=(
                'cue = state.get("cue", "")\n'
                'gm_tool("say", npc_id=state["acting"], text=cue[:19], to=None)\n'
            ),
        ),
        engine=engine,
        timeout_seconds=5,
    )
    assert result.ok, result.error
    assert [record.tool for record in result.trace] == ["say"]
    assert result.trace[0].input["text"] == "the player has come"
