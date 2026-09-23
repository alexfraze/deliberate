"""Spatial scoping (ALE-45): the prompt stays inside 12k as the world grows.

The claim under test is a *ceiling*, so it is tested the only way a ceiling can be: by building
worlds far past anything the gatehouse can show and measuring the assembled prompt at each size.
`tests/test_live.py` re-measures the same sizes against the real tokenizer, because the estimate
has been wrong before — at `chars/4` it ran 40% under and a "12k budget" was letting 20k through.
"""

from __future__ import annotations

import pytest

from deliberate_gm.agent import GmAgent, estimate_tokens
from deliberate_gm.config import Settings
from deliberate_gm.contracts import ToolContract
from deliberate_gm.llm import LLMResult, ScriptedLLM
from deliberate_gm.memory import blocks as memory_blocks
from deliberate_gm.models import LedgerEntry, MemoryBlocks, TurnRequest
from deliberate_gm.prompt import LADDER, SCOPE_NOTE, fit, scope_state
from deliberate_gm.stub_engine import StubEngine

from .world import PLAYER, entity_ids, map_id, synthetic_state

#: A one-map world, the world M4 starts from, and three sizes past it. The last is well beyond
#: what the milestone plans for (decision 7 budgets "a twenty-location world"), which is the
#: point: a ceiling that only holds at the sizes it was tuned on is not a ceiling.
SIZES = [(1, 3), (4, 6), (12, 8), (30, 12)]

VERBATIM = LADDER[0]
TIGHTEST = LADDER[-1]


def loaded_memory() -> MemoryBlocks:
    """A turn carrying as much memory as the blocks will hold. Scoping has to leave room for it."""
    return MemoryBlocks(
        world_model=[f"The garrison changes watch at dusk. ({i})" for i in range(12)],
        player_profile=[f"Prefers to talk before drawing. ({i})" for i in range(8)],
        threads=[
            {"id": f"q:{i}", "name": f"Thread {i}", "step": i, "of": 5, "summary": "x" * 80}
            for i in range(4)
        ],
        npcs=[
            {"id": f"npc:{i}", "name": f"Person {i}", "disposition": -i, "goal": "y" * 80}
            for i in range(6)
        ],
        ledger=[
            LedgerEntry(
                turn=i,
                tool="move",
                intent="move(entity_id=npc:gorm, to={x: 4, y: 9})",
                ok=False,
                outcome="rejected",
                reason="That tile is a wall.",
            )
            for i in range(12)
        ],
    )


def turn_for(state: dict[str, object]) -> TurnRequest:
    return TurnRequest(
        session="scope",
        turn=40,
        phase="preview",
        state=state,
        entities=entity_ids(state),
        player_intent={"kind": "move", "entity_id": PLAYER, "to": {"x": 3, "y": 4}},
        player_text="I want to look around and see who is here.",
        memory=loaded_memory(),
    )


def prompt_tokens(settings: Settings, contract: ToolContract, request: TurnRequest) -> int:
    llm = ScriptedLLM(
        [LLMResult(content=[{"type": "text", "text": "done"}], stop_reason="end_turn")]
    )
    GmAgent(llm=llm, engine=StubEngine(), contract=contract, settings=settings).run_turn(request)
    sent = llm.requests[0]
    return estimate_tokens({"system": sent.system, "tools": sent.tools, "messages": sent.messages})


# -- the ceiling ----------------------------------------------------------------------------


@pytest.mark.parametrize(("maps", "per_map"), SIZES)
def test_the_prompt_holds_its_budget_as_the_world_grows(
    settings: Settings, contract: ToolContract, maps: int, per_map: int
) -> None:
    request = turn_for(synthetic_state(maps=maps, npcs_per_map=per_map))
    assert prompt_tokens(settings, contract, request) <= settings.input_token_budget


def test_without_scoping_a_large_world_would_not_fit(
    settings: Settings, contract: ToolContract
) -> None:
    """The control. Without this, the test above would pass on a world that never overflowed.

    `stateSummary` lists every entity in the world with no map filter, so it grows linearly with
    the world and nothing downstream used to stop it. This is that overflow, measured.
    """
    maps, per_map = SIZES[-1]
    state = synthetic_state(maps=maps, npcs_per_map=per_map)
    request = turn_for(state)
    unscoped = estimate_tokens({"tools": [], "messages": [{"role": "user", "content": state}]})
    assert unscoped > settings.input_token_budget
    assert prompt_tokens(settings, contract, request) <= settings.input_token_budget


@pytest.mark.parametrize(("maps", "per_map"), SIZES)
def test_memory_still_gets_its_floor_at_every_size(
    settings: Settings, contract: ToolContract, maps: int, per_map: int
) -> None:
    """Fitting the state rather than the memory is the point: a scoped turn that then sheds every
    block has bought nothing, and before ALE-45 that is exactly what a four-map world did — the
    unbounded summary took the budget down to memory's 400-token floor and the ledger folded to
    nothing. The ledger is the only block that records what actually happened."""
    request = turn_for(synthetic_state(maps=maps, npcs_per_map=per_map))
    llm = ScriptedLLM(
        [LLMResult(content=[{"type": "text", "text": "done"}], stop_reason="end_turn")]
    )
    response = GmAgent(llm=llm, engine=StubEngine(), contract=contract, settings=settings).run_turn(
        request
    )
    assert len(response.memory.ledger) == len(request.memory.ledger)
    assert response.memory.world_model == request.memory.world_model
    held = memory_blocks.reserve(request.memory, budget=settings.input_token_budget)
    assert held > memory_blocks.MIN_MEMORY_TOKENS


# -- what scoping keeps ---------------------------------------------------------------------


def test_a_one_map_world_is_untouched() -> None:
    """A small world pays nothing for this module existing; `full` is the first rung."""
    state = synthetic_state(maps=1, npcs_per_map=3)
    assert fit(state, fits=lambda _: True) == (state, VERBATIM)
    assert scope_state(state, VERBATIM) is state


def test_the_players_own_map_survives_intact() -> None:
    state = synthetic_state(maps=8, npcs_per_map=5)
    scoped = scope_state(state, LADDER[1])
    here = {e["id"] for e in scoped["entities"]}
    assert scoped["here"] == map_id(0)
    assert PLAYER in here
    assert here == {e["id"] for e in state["entities"] if e["map"] == map_id(0)}
    assert SCOPE_NOTE in scoped["scope"]


def test_other_maps_become_a_line_each() -> None:
    state = synthetic_state(maps=8, npcs_per_map=5)
    scoped = scope_state(state, LADDER[1])
    rows = {row["map"]: row for row in scoped["elsewhere"]}
    assert len(rows) == 7
    assert all(row["count"] == 5 for row in rows.values())
    # Adjacency, when the caller supplies it, is what earns a map its names.
    assert "who" in rows[map_id(1)]
    assert "who" not in rows[map_id(4)]


def test_the_next_rung_drops_the_names_and_keeps_the_counts() -> None:
    """A count is not nothing: it is the difference between a world the game master knows
    continues past the door and one it believes ends there."""
    state = synthetic_state(maps=8, npcs_per_map=5)
    scoped = scope_state(state, LADDER[2])
    assert all("who" not in row for row in scoped["elsewhere"])
    assert sum(row["count"] for row in scoped["elsewhere"]) == 35


def test_the_tightest_rung_keeps_the_nearest_people_on_this_map() -> None:
    state = synthetic_state(maps=30, npcs_per_map=20)
    scoped = scope_state(state, TIGHTEST)
    kept = [e for e in scoped["entities"] if e["map"] == map_id(0)]
    assert len(kept) == TIGHTEST.here
    assert PLAYER in {e["id"] for e in kept}
    # Nearest first: nobody kept is further off than somebody dropped.
    dropped = [
        e
        for e in state["entities"]
        if e["map"] == map_id(0) and e["id"] not in {k["id"] for k in kept}
    ]
    far = min(_chebyshev(e) for e in dropped)
    assert max(_chebyshev(e) for e in kept) <= far
    assert "also_here" in scoped


def test_the_acting_entity_is_never_scoped_away() -> None:
    """The turn is about them. An ambient NPC chosen on another map, or a combatant in the
    initiative order, stays in the summary wherever they are standing."""
    state = synthetic_state(maps=12, npcs_per_map=20, acting="npc:yard:19", cue="a door opened")
    state["initiative"] = {"order": ["npc:undercroft:18", PLAYER], "current": 0}
    scoped = scope_state(state, TIGHTEST)
    present = {e["id"] for e in scoped["entities"]}
    assert {"npc:yard:19", "npc:undercroft:18", PLAYER} <= present
    # ...and they are not double-counted in the map they were pulled out of.
    rows = {row["map"]: row["count"] for row in scoped["elsewhere"] if "map" in row}
    assert rows[map_id(1)] == 19


def test_a_world_of_many_maps_folds_the_far_ones_together() -> None:
    """The ceiling has to hold at sizes nobody planned for, or it is not a ceiling. Past the
    tightest rung's cap even the per-map counts fold, so `elsewhere` stops growing with the world.
    """
    state = synthetic_state(maps=200, npcs_per_map=25)
    scoped = scope_state(state, TIGHTEST)
    rows = scoped["elsewhere"]
    assert len(rows) == TIGHTEST.maps + 1
    assert rows[-1]["maps"] == 199 - TIGHTEST.maps
    # Nothing is lost from the count: every soul off this map is still accounted for.
    assert sum(int(row["count"]) for row in rows) == 199 * 25
    # And the maps that kept their names are the ones next door.
    assert [row["map"] for row in rows[:2]] == sorted(state["adjacent"])


def test_a_summary_with_no_map_labels_is_left_alone() -> None:
    """Backward compatibility with a caller that has not been taught to label positions: it gets
    exactly the behaviour it had before, rather than a silently emptied world."""
    state = {"acting": None, "entities": [{"id": "npc:gorm", "at": {"x": 1, "y": 1}}]}
    assert scope_state(state, TIGHTEST) is state


def test_quests_and_flags_are_capped_only_on_the_tight_rungs() -> None:
    state = synthetic_state(maps=30, npcs_per_map=12, quests=40, flags=60)
    assert len(scope_state(state, LADDER[1])["quests"]) == 40
    assert len(scope_state(state, TIGHTEST)["quests"]) == TIGHTEST.lists
    assert len(scope_state(state, TIGHTEST)["flags"]) == TIGHTEST.lists


def test_the_ladder_descends_only_as_far_as_it_has_to() -> None:
    """Each rung is tried in order and the first that fits wins, so the game master is never
    shown less than the budget could have afforded."""
    state = synthetic_state(maps=12, npcs_per_map=8)
    sizes = [estimate_tokens(scope_state(state, rung)) for rung in LADDER]
    assert sizes == sorted(sizes, reverse=True)
    _, chosen = fit(state, fits=lambda s: estimate_tokens(s) <= sizes[2])
    assert chosen is LADDER[2]


def _chebyshev(entity: dict[str, object]) -> int:
    at = entity["at"]
    assert isinstance(at, dict)
    return max(abs(int(at["x"])), abs(int(at["y"])))
