"""Memory blocks (ALE-15).

The block that matters most is the verified ledger, and the property that matters most is
that it records the engine's verdict rather than the model's account of it.
"""

from __future__ import annotations

from deliberate_gm.agent import GmAgent, ledger_entry
from deliberate_gm.llm import LLMResult, ScriptedLLM
from deliberate_gm.memory import blocks, ledger, notes
from deliberate_gm.models import LedgerEntry, MemoryBlocks, ToolCallRecord

from .conftest import say


def build(llm, engine, tools, settings, **kwargs):
    return GmAgent(llm=llm, engine=engine, tools=tools, settings=settings, **kwargs)


# -- the ledger records the engine, not the model ------------------------------------------


def test_the_ledger_records_the_engine_not_the_model_claim(
    engine, tools, settings, turn_request
) -> None:
    """The model says it hit for 12. The engine says the target is out of range.

    Only one of those is a fact, and only one of them reaches the ledger.
    """
    engine.reject("attack", "Gorm is four tiles away; your reach is one.")
    llm = ScriptedLLM(
        [
            LLMResult(
                content=[
                    {
                        "type": "text",
                        "text": (
                            "I hit Gorm for 12 damage and he is now bloodied.\n"
                            "World model: Gorm is at 6 hit points and nearly dead."
                        ),
                    },
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "attack",
                        "input": {
                            "attacker": "pc:ari",
                            "target": "npc:gorm",
                            "ability": "sword",
                        },
                    },
                ],
                stop_reason="tool_use",
            ),
            say("Ari lunges, and the distance swallows the blow."),
        ]
    )

    response = build(llm, engine, tools, settings).run_turn(turn_request)

    assert len(response.memory.ledger) == 1
    entry = response.memory.ledger[0]
    assert entry.ok is False
    assert entry.outcome == "rejected"
    assert entry.reason == "Gorm is four tiles away; your reach is one."
    assert entry.intent.startswith("attack(")
    # Nothing the model asserted about the outcome is anywhere in the ledger.
    rendered = ledger.render(response.memory.ledger, response.memory.ledger_digest)
    assert "12 damage" not in rendered
    assert "bloodied" not in rendered


def test_the_model_claim_survives_only_as_its_own_note(
    engine, tools, settings, turn_request
) -> None:
    """The world-model block is the model's, so its belief is kept -- clearly labelled as a
    note it must revise, and sitting next to a ledger line that contradicts it."""
    engine.reject("attack", "out of range")
    llm = ScriptedLLM(
        [
            LLMResult(
                content=[
                    {"type": "text", "text": "World model: npc:gorm is nearly dead."},
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "attack",
                        "input": {"attacker": "pc:ari", "target": "npc:gorm", "ability": "sword"},
                    },
                ],
                stop_reason="tool_use",
            ),
            say("The blow falls short."),
        ]
    )
    response = build(llm, engine, tools, settings).run_turn(turn_request)
    assert response.memory.world_model == ["npc:gorm is nearly dead."]
    text, _ = blocks.render(response.memory, budget=4000)
    assert "## World model" in text
    assert "Revise any of them the moment the engine contradicts one." in text
    assert "rejected" in text


def test_a_query_leaves_no_ledger_line() -> None:
    record = ToolCallRecord(call_id="1", tool="get_state", ok=True, kind="query", result={})
    assert ledger_entry(1, record) is None


def test_a_skipped_batch_call_is_recorded_as_not_executed() -> None:
    record = ToolCallRecord(call_id="1", tool="attack", ok=False, executed=False, reason="stopped")
    entry = ledger_entry(4, record)
    assert entry is not None
    assert entry.ok is False
    assert entry.outcome == "not executed (batch stopped)"


# -- compaction, not truncation ------------------------------------------------------------


def make_entries(count: int, *, ok: bool = True, tool: str = "attack") -> list[LedgerEntry]:
    return [
        LedgerEntry(
            turn=index + 1,
            tool=tool,
            intent=f"{tool}(n={index})",
            ok=ok,
            outcome="applied" if ok else "rejected",
            reason=None if ok else "out of range",
        )
        for index in range(count)
    ]


def test_compaction_keeps_every_outcome() -> None:
    entries = make_entries(20) + make_entries(10, ok=False, tool="move")
    kept, digest = ledger.compact(entries, None, keep_recent=5)

    assert len(kept) == 5
    assert digest is not None
    # 30 attempts in, 25 folded plus 5 kept: nothing was thrown away.
    assert digest.total == 25
    assert digest.total + len(kept) == len(entries)
    assert digest.applied["attack"] == 20
    assert digest.rejected["move"] == 5
    assert digest.reasons["out of range"] == 5


def test_compaction_is_cumulative_across_turns() -> None:
    kept, digest = ledger.compact(make_entries(10), None, keep_recent=2)
    kept, digest = ledger.compact(kept + make_entries(10), digest, keep_recent=2)
    assert digest is not None
    assert digest.total + len(kept) == 20


def test_the_digest_caps_reason_variety_without_losing_the_count() -> None:
    entries = [
        LedgerEntry(
            turn=index,
            tool="cast",
            intent="cast()",
            ok=False,
            outcome="rejected",
            reason=f"reason {index}",
        )
        for index in range(12)
    ]
    _, digest = ledger.compact(entries, None, keep_recent=0)
    assert digest is not None
    assert sum(digest.reasons.values()) == 12
    assert len(digest.reasons) <= ledger.DIGEST_REASON_LIMIT + 1


# -- the token budget ----------------------------------------------------------------------


def test_the_ledger_is_shed_last_and_never_entirely() -> None:
    memory = MemoryBlocks(
        world_model=[f"a long world-model note number {i} " * 4 for i in range(12)],
        player_profile=[f"profile note {i} " * 4 for i in range(8)],
        ledger=make_entries(30),
    )
    text, fitted = blocks.render(memory, budget=120)

    assert "## Verified ledger" in text
    assert fitted.ledger_digest is not None
    assert fitted.ledger_digest.applied["attack"] + len(fitted.ledger) == 30
    # Everything sheddable was shed before the ledger folded to nothing.
    assert fitted.player_profile == []
    assert fitted.world_model == []


def test_rendering_returns_the_memory_that_was_actually_rendered() -> None:
    memory = MemoryBlocks(ledger=make_entries(40))
    text, fitted = blocks.render(memory, budget=4000)
    # The caller persists `fitted`, so the next turn starts from the compacted form rather
    # than re-shedding the same overflow forever.
    assert len(fitted.ledger) <= ledger.DEFAULT_KEEP_RECENT
    assert fitted.ledger_digest is not None
    assert str(fitted.ledger[-1].turn) in text


def test_a_thirty_turn_session_stays_under_the_input_budget(
    engine, tools, settings, turn_request
) -> None:
    """ALE-15's acceptance: 30 turns, prompt under budget, ledger reflecting the engine."""
    engine.accept("move", diff=[{"type": "EntityMoved", "entity": "pc:ari"}])
    engine.reject("attack", "Gorm is four tiles away; your reach is one.")
    agent_settings = settings  # 12k budget

    memory = MemoryBlocks()
    applied = rejected = 0
    for turn in range(1, 31):
        llm = ScriptedLLM(
            [
                LLMResult(
                    content=[
                        {
                            "type": "text",
                            "text": (
                                "World model: the gatehouse still bars the north "
                                f"road (turn {turn}). "
                                + "The mud is deep and slows everyone. " * 6
                                + f"\nPlayer: likes flanking, turn {turn}."
                            ),
                        },
                        {
                            "type": "tool_use",
                            "id": f"toolu_m{turn}",
                            "name": "move",
                            "input": {"entity_id": "pc:ari", "to": {"x": turn, "y": 2}},
                        },
                        {
                            "type": "tool_use",
                            "id": f"toolu_a{turn}",
                            "name": "attack",
                            "input": {
                                "attacker": "pc:ari",
                                "target": "npc:gorm",
                                "ability": "sword",
                            },
                        },
                    ],
                    stop_reason="tool_use",
                ),
                say(f"Turn {turn}: Ari slogs forward and swings at nothing."),
            ]
        )
        request = turn_request.model_copy(
            update={
                "turn": turn,
                "memory": memory,
                "npcs": [],
                "state": {"entities": ["pc:ari", "npc:gorm"], "tick": turn},
            }
        )
        response = build(llm, engine, tools, agent_settings).run_turn(request)
        memory = response.memory
        applied += 1
        rejected += 1

        assert response.prompt_tokens_estimate <= agent_settings.input_token_budget, (
            f"turn {turn} blew the budget at {response.prompt_tokens_estimate} tokens"
        )

    assert memory.ledger_digest is not None
    total = memory.ledger_digest.total + len(memory.ledger)
    assert total == applied + rejected == 60
    # Every outcome is the engine's, and none of them was lost to compaction.
    assert (
        memory.ledger_digest.applied.get("move", 0)
        + sum(1 for entry in memory.ledger if entry.tool == "move" and entry.ok)
        == 30
    )
    assert (
        memory.ledger_digest.rejected.get("attack", 0)
        + sum(1 for entry in memory.ledger if entry.tool == "attack" and not entry.ok)
        == 30
    )
    reason = "Gorm is four tiles away; your reach is one."
    assert (
        memory.ledger_digest.reasons[reason]
        + sum(1 for entry in memory.ledger if entry.reason == reason)
        == 30
    )
    # The model-authored blocks stayed capped rather than growing for thirty turns.
    assert len(memory.world_model) <= notes.CAPS["world_model"][0]
    assert len(memory.player_profile) <= notes.CAPS["player_profile"][0]


# -- what the model may and may not write --------------------------------------------------


def test_notes_are_harvested_only_under_their_labels() -> None:
    harvested = notes.harvest(
        "The road is quiet.\n"
        "World model: the bridge is out.\n"
        "Player: prefers talking first.\n"
        "Ledger: the attack succeeded.\n"
        "Disposition: gorm is +5.\n"
    )
    assert harvested["world_model"] == ["the bridge is out."]
    assert harvested["player_profile"] == ["prefers talking first."]
    # `Ledger:` and `Disposition:` are engine-owned and are not labels at all.
    assert not any("attack succeeded" in note for notes_ in harvested.values() for note in notes_)
    assert not any("+5" in note for notes_ in harvested.values() for note in notes_)


def test_a_note_about_an_unknown_entity_is_dropped() -> None:
    kept, dropped = notes.check_entities(
        [
            "npc:gorm guards the gate.",
            "npc:phantom waits in the cellar.",
            "The cellar is flooded.",
        ],
        {"pc:ari", "npc:gorm"},
    )
    assert kept == ["npc:gorm guards the gate.", "The cellar is flooded."]
    assert dropped == ["npc:phantom waits in the cellar."]


def test_the_agent_drops_notes_the_engine_cannot_vouch_for(
    engine, tools, settings, turn_request
) -> None:
    llm = ScriptedLLM(
        [
            say(
                "World model: npc:phantom is my ally.\n\n"
                "World model: npc:gorm blocks the north road."
            )
        ]
    )
    response = build(llm, engine, tools, settings).run_turn(turn_request)
    assert response.memory.world_model == ["npc:gorm blocks the north road."]


def test_dispositions_come_from_the_engine_block_not_from_notes() -> None:
    memory = MemoryBlocks(
        npcs=[{"id": "npc:gorm", "name": "Gorm", "disposition": -3, "goal": "hold the gate"}],
        world_model=["npc:gorm now likes us, disposition +9."],
    )
    text, _ = blocks.render(memory, budget=4000)
    people = text.split("## People")[1].split("##")[0]
    assert "disposition -3" in people
    assert "+9" not in people
    assert "Dispositions are the engine's numbers" in text


def test_the_player_profile_is_capped() -> None:
    profile = notes.merge([], [f"note {i}" for i in range(30)], block="player_profile")
    assert len(profile) == notes.CAPS["player_profile"][0]
    assert profile[-1] == "note 29"


def test_a_repeated_note_moves_to_the_end_rather_than_duplicating() -> None:
    merged = notes.merge(["a", "b"], ["a"], block="world_model")
    assert merged == ["b", "a"]


def test_threads_render_the_engines_step() -> None:
    memory = MemoryBlocks(
        threads=[
            {
                "id": "q:bridge",
                "name": "The bridge toll",
                "step": 2,
                "of": 5,
                "summary": "pay or fight",
            }
        ]
    )
    text, _ = blocks.render(memory, budget=4000)
    assert "The bridge toll (q:bridge): step 2 of 5 — pay or fight" in text
