"""Spatial scoping: what the game master is shown about a world too big to describe.

`docs/m4-swarm.md` decision 6. The turn prompt is capped at 12k input tokens, and the engine's
state summary is one of the *fixed* parts of it — the parts `agent.py` measures first and gives
memory whatever is left. That arithmetic was written when there was one map and three people on
it. A world of thirty maps and a hundred and fifty people does not fit, and it does not fail
loudly either: it silently eats the whole budget, memory sheds to its floor, and the turn goes
out over budget carrying a list of strangers on maps the player has never seen.

It is not a storage problem. The summary is cheap to compute and cheap to send. It is a *budget*
problem, and the budget is only knowable here, where the system prompt, the seventeen tool
schemas, the player's text and the memory blocks are all in hand at once. So this is the last
line of defence and it is unconditional: whatever arrives, something inside the budget goes out.

What the game master gets is therefore **spatial**:

* the map the player is standing on, in full;
* the maps next door, as one line each — who is there, and how many;
* everywhere else, as a count.

Anything beyond that it asks for, with `get_state` for the board and `recall(topic)` for the
record. That is the same discipline as the rest of this service — reading state is free, and
guessing at it is the most common way to narrate something that did not happen — so scoping does
not take information away from the game master. It takes it *out of the standing cost of a turn*,
which is the whole of decision 7's "do not let the cost shape rot".

Nothing here is authoritative and nothing here is a rule. It decides what is shown, never what is
true, and an entity that was scoped out is one free query away.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

#: Told to the model whenever a summary was scoped, so a short list reads as *near* rather than
#: as *all*. Without it the most likely failure is the model narrating an empty world confidently.
SCOPE_NOTE = (
    "This summary is scoped to where the player is standing. It is not the whole world: "
    "`get_state` reads the board and `recall` searches the record for anything not listed here."
)


@dataclass(frozen=True)
class Scope:
    """One rung of the ladder. Each drops strictly more than the rung above it."""

    name: str
    #: Everything arrives untouched. The one-map world, and what every session starts as.
    verbatim: bool = False
    #: How many people on the player's own map to keep, nearest first. `None` keeps all of them.
    here: int | None = None
    #: Names to list for a map in the vicinity. `0` renders a bare count.
    neighbour_names: int = 0
    #: Other maps to name at all. Beyond it they fold into one "and n more" line — otherwise a
    #: two-hundred-map world pays for a line per map and the ceiling leaks at the top rung.
    maps: int | None = None
    #: Cap on the quest and flag lists. `None` leaves them alone.
    lists: int | None = None


#: Loosest first. `fit` takes the first rung that fits, so a small world pays nothing at all for
#: this file existing and a large one pays exactly as much as it has to.
#:
#: The rungs are ordered by what the turn can most afford to lose, which is the same reasoning as
#: `memory/blocks.py`'s shedding order: distance from the player first, then detail about the
#: neighbourhood, then detail about the room, and the room itself never empties. The player's own
#: map keeps at least six people even on the tightest rung, because a room the game master is told
#: is empty is worse than a room it is told is crowded.
LADDER: tuple[Scope, ...] = (
    Scope("full", verbatim=True),
    Scope("vicinity", neighbour_names=4),
    Scope("map", neighbour_names=0),
    Scope("near", here=12, maps=12, lists=12),
    Scope("here", here=6, maps=4, lists=5),
)


def scope_state(state: dict[str, Any], scope: Scope) -> dict[str, Any]:
    """Re-render the engine's state summary at `scope`. Pure; the input is never mutated.

    Leaves the summary alone when there is nothing spatial to key on — no entity list, or no
    entity carrying a `map`. A caller that has not been taught to label positions gets exactly
    the behaviour it had before, rather than a silently emptied world.
    """
    entities = [e for e in state.get("entities") or [] if isinstance(e, dict)]
    home = here_map(state, entities)
    if scope.verbatim or home is None:
        return state

    anchors = _anchors(state)
    origin = _origin(entities, state, home)
    here: list[dict[str, Any]] = []
    away: list[dict[str, Any]] = []
    for entity in entities:
        (here if _map_of(entity) == home else away).append(entity)
    # Nearest first: when the room has to be cut, the people the player can actually see stay.
    here.sort(key=lambda e: (_distance(origin, e.get("at")), str(e.get("id"))))

    kept, cut = here, 0
    if scope.here is not None and len(here) > scope.here:
        kept = here[: scope.here] + [e for e in here[scope.here :] if _id(e) in anchors]
        cut = len(here) - len(kept)
    # Someone in initiative, or the entity whose turn it is, is never summarised away wherever
    # they are standing: the turn is about them.
    kept += [e for e in away if _id(e) in anchors]

    out = dict(state)
    out["here"] = home
    out["entities"] = kept
    out["scope"] = SCOPE_NOTE
    elsewhere = _elsewhere(away, anchors, set(state.get("adjacent") or ()), scope)
    if elsewhere:
        out["elsewhere"] = elsewhere
    if cut:
        out["also_here"] = f"{cut} more on this map, further off; `get_state` lists them"
    if scope.lists is not None:
        out["quests"] = _cap(state.get("quests"), scope.lists)
        out["flags"] = _cap(state.get("flags"), scope.lists)
    return out


def fit(
    state: dict[str, Any], *, fits: Callable[[dict[str, Any]], bool]
) -> tuple[dict[str, Any], Scope]:
    """Scope `state` to the loosest rung that `fits`, falling back to the tightest.

    `fits` belongs to the caller because only the caller knows what else is in the prompt. The
    fallback is deliberate rather than an error: a turn that cannot be made to fit still has to
    go out, and the tightest rung is the smallest honest thing to send.

    Trying the rungs in order means rendering the message once per rung. Measured, whole-turn
    prompt assembly costs 1.6 ms at 12 maps, 3.8 ms at 30 and 145 ms at an absurd 200 maps and
    5,000 people -- against a model call of several seconds. Decision 7 budgets a twenty-location
    world, so this is not worth a short-circuit; if that ever stops being true, the state alone is
    a lower bound on the message and a rung that exceeds the ceiling on its own can be skipped
    without rendering anything.
    """
    scoped = state
    for scope in LADDER:
        scoped = scope_state(state, scope)
        if fits(scoped):
            return scoped, scope
    return scoped, LADDER[-1]


def here_map(state: dict[str, Any], entities: list[dict[str, Any]] | None = None) -> str | None:
    """The map the turn is happening on: where the player stands, or where the actor does.

    Derived rather than required, so this works against a caller that only labels positions.
    The player comes first even on an ambient turn: the acting NPC is chosen *for* being near
    the player (`ambient.ts`), and it is the player's surroundings the prompt is paying for.
    """
    labelled = [e for e in entities if _map_of(e)] if entities is not None else []
    if state.get("here"):
        return str(state["here"])
    for entity in labelled:
        if entity.get("brain") == "player":
            return _map_of(entity)
    acting = state.get("acting")
    for entity in labelled:
        if _id(entity) == acting:
            return _map_of(entity)
    return None


def _elsewhere(
    away: list[dict[str, Any]],
    anchors: set[str],
    adjacent: set[str],
    scope: Scope,
) -> list[dict[str, Any]]:
    """One line per other map. Named for the maps next door, counted for the rest.

    A count is not nothing: "four people in the undercroft" is the difference between a world
    the game master knows continues past the door and one it believes ends there. Past
    `scope.maps` even the counts fold together, because at that point the useful fact is that
    the world goes on, not the name of the ninetieth room in it.
    """
    rows: list[dict[str, Any]] = []
    # Maps next door first, so they are the ones that survive the cut.
    for map_id in sorted({_map_of(e) or "" for e in away}, key=lambda m: (m not in adjacent, m)):
        group = [e for e in away if (_map_of(e) or "") == map_id and _id(e) not in anchors]
        if not group:
            continue
        row: dict[str, Any] = {"map": map_id, "count": len(group)}
        # With no adjacency in the summary every other map is treated as next door; the rung
        # below counts them all anyway, so the ladder still terminates.
        if scope.neighbour_names and (not adjacent or map_id in adjacent):
            row["who"] = [str(e.get("name") or _id(e)) for e in group[: scope.neighbour_names]]
        rows.append(row)
    if scope.maps is not None and len(rows) > scope.maps:
        folded = rows[scope.maps :]
        rows = rows[: scope.maps]
        rows.append(
            {
                "maps": len(folded),
                "count": sum(int(row["count"]) for row in folded),
                "note": "further off; `recall` finds them by name",
            }
        )
    return rows


def _anchors(state: dict[str, Any]) -> set[str]:
    """Ids this turn is about, wherever they are standing."""
    out = {str(state["acting"])} if state.get("acting") else set()
    initiative = state.get("initiative")
    if isinstance(initiative, dict):
        out |= {str(i) for i in initiative.get("order") or ()}
    return out


def _origin(
    entities: list[dict[str, Any]], state: dict[str, Any], home: str
) -> dict[str, Any] | None:
    """Where "near" is measured from: the player, or the acting entity if there is no player."""
    acting = state.get("acting")
    for entity in entities:
        if entity.get("brain") == "player" and _map_of(entity) == home:
            return entity.get("at") if isinstance(entity.get("at"), dict) else None
    for entity in entities:
        if _id(entity) == acting:
            return entity.get("at") if isinstance(entity.get("at"), dict) else None
    return None


def _distance(origin: dict[str, Any] | None, at: Any) -> float:
    """Chebyshev tiles, matching the engine's 8-way grid. Only the ordering is used."""
    if origin is None or not isinstance(at, dict):
        return float("inf")
    try:
        return max(
            abs(float(at["x"]) - float(origin["x"])), abs(float(at["y"]) - float(origin["y"]))
        )
    except (KeyError, TypeError, ValueError):
        return float("inf")


def _cap(value: Any, limit: int) -> Any:
    if isinstance(value, list):
        return value[:limit]
    if isinstance(value, dict):
        return dict(sorted(value.items())[:limit])
    return value


def _map_of(entity: dict[str, Any]) -> str | None:
    value = entity.get("map")
    return str(value) if value else None


def _id(entity: dict[str, Any]) -> str:
    return str(entity.get("id") or "")


__all__ = ["LADDER", "SCOPE_NOTE", "Scope", "fit", "here_map", "scope_state"]
