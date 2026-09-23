"""A synthetic multi-map world, in the shape `stateSummary` sends.

M4's two failure modes both need a world bigger than anyone can reach by playing: a prompt that
only overflows at twenty maps, and an ambient turn that only starves at fifty NPCs. The gatehouse
is one map and three people, so a test written against it demonstrates neither.

This builds the summary `packages/server/src/gm/loop.ts` produces — the same keys, the same entity
records, the same `map` label on each position — at whatever size the test asks for. It is not a
snapshot and nothing validates against it: it is the *shape of the payload*, which is the only
thing the budget cares about.
"""

from __future__ import annotations

from typing import Any

PLAYER = "pc:ari"

#: Maps are laid out in a ring, so "adjacent" means something without an engine: each map's
#: neighbours are the ones before and after it.
MAP_NAMES = (
    "gatehouse",
    "yard",
    "undercroft",
    "north-road",
    "chapel",
    "stables",
    "watchtower",
    "kitchens",
    "cellars",
    "orchard",
)


def map_id(index: int) -> str:
    base = MAP_NAMES[index % len(MAP_NAMES)]
    return base if index < len(MAP_NAMES) else f"{base}-{index // len(MAP_NAMES)}"


def synthetic_state(
    *,
    maps: int,
    npcs_per_map: int,
    width: int = 40,
    acting: str | None = None,
    cue: str | None = None,
    quests: int = 6,
    flags: int = 12,
) -> dict[str, Any]:
    """The engine's state summary for a world of `maps` maps with `npcs_per_map` people on each.

    The player stands at the origin of map 0. NPCs are spread across the width of their map, so
    the ones the player could actually see are a minority of the ones on it — which is the case
    the nearest-first cut in `prompt/scope.py` exists for.
    """
    home = map_id(0)
    entities: list[dict[str, Any]] = [
        _entity(PLAYER, "Ari", home, 0, 0, brain="player", faction="players")
    ]
    for m in range(maps):
        where = map_id(m)
        for n in range(npcs_per_map):
            entities.append(
                _entity(
                    f"npc:{where}:{n}",
                    f"{where.title().replace('-', ' ')} {n}",
                    where,
                    (n * 7) % width,
                    (n * 11) % width,
                    faction="garrison" if n % 2 else "townsfolk",
                )
            )
    return {
        "acting": acting,
        **({"cue": cue} if cue else {}),
        "clock": 12,
        "flags": {f"flag:{i}": i % 2 == 0 for i in range(flags)},
        "quests": [
            {
                "id": f"q:{i}",
                "title": f"The matter of the {MAP_NAMES[i % len(MAP_NAMES)]}",
                "step": i % 4,
                "of": 4,
            }
            for i in range(quests)
        ],
        "initiative": None,
        "adjacent": [map_id(i) for i in (1, maps - 1)][: max(0, min(2, maps - 1))],
        "entities": entities,
    }


def entity_ids(state: dict[str, Any]) -> list[str]:
    return [str(e["id"]) for e in state["entities"]]


def _entity(
    ident: str,
    name: str,
    where: str,
    x: int,
    y: int,
    *,
    brain: str = "gm",
    faction: str = "garrison",
) -> dict[str, Any]:
    return {
        "id": ident,
        "name": name,
        "brain": brain,
        "faction": faction,
        "map": where,
        "at": {"x": x, "y": y},
        "hp": 11,
        "maxHp": 14,
        "conditions": [],
        "disposition": {} if brain == "player" else {PLAYER: (x + y) % 40 - 10},
    }
