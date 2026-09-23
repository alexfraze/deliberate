"""Assembling the memory blocks, and fitting them to the turn's token budget.

Five blocks, re-injected every turn:

| Block          | Author                | Checked by                                 |
| -------------- | --------------------- | ------------------------------------------ |
| World model    | the model             | the engine's entity list (unknown ids drop) |
| Active threads | the engine            | --                                         |
| People         | goals: model; **dispositions: engine numbers** | --                        |
| Verified ledger| **the engine**        | --                                         |
| Player profile | the model             | capped                                     |

When it does not fit, blocks are shed in a fixed order, and the ledger is shed last and never
entirely: it is the only block that records what actually happened.
"""

from __future__ import annotations

from typing import Any

from ..models import MemoryBlocks
from ..tokens import CHARS_PER_TOKEN
from . import ledger as ledger_module
from .notes import CAPS

#: Even a starved turn gets this much memory; below it the blocks stop being useful.
MIN_MEMORY_TOKENS = 400
#: How far the ledger is folded, each time shedding comes back round to it.
LEDGER_SHED_STEP = 4
#: The most of the turn's budget the *world* may take before the spatial ladder starts tightening
#: (ALE-45). Memory is still shed to fit whatever is left, so this is not a guarantee — it is the
#: point at which the cheaper thing to give up is a stranger on another map rather than the record
#: of what the engine already refused. A third is where a fully loaded set of blocks lands.
MEMORY_RESERVE_SHARE = 3


def estimate(text: str) -> int:
    """The same measured characters-per-token as the rest of the budget arithmetic."""
    return max(0, int(len(text) / CHARS_PER_TOKEN))


def reserve(memory: MemoryBlocks, *, budget: int) -> int:
    """How much of `budget` to hold back for these blocks before scoping the state (ALE-45).

    What they would cost rendered whole, floored so a starved turn still gets something and
    capped so a runaway world model cannot crowd out the board. Blocks smaller than the cap ask
    for less, so an early turn with almost no memory spends almost the whole budget on the world.
    """
    whole = estimate(_render(memory))
    return max(MIN_MEMORY_TOKENS, min(whole, budget // MEMORY_RESERVE_SHARE))


def render(memory: MemoryBlocks, *, budget: int) -> tuple[str, MemoryBlocks]:
    """Render the blocks to fit `budget`, returning the text and the memory that produced it.

    The returned memory is what the caller should persist: shedding is real, so the next turn
    starts from the compacted form rather than re-shedding the same overflow forever.
    """
    fitted = memory.model_copy(deep=True)
    entries = list(fitted.ledger)
    digest = fitted.ledger_digest
    keep_recent = ledger_module.DEFAULT_KEEP_RECENT

    while True:
        fitted.ledger, fitted.ledger_digest = ledger_module.compact(
            entries, digest, keep_recent=keep_recent
        )
        text = _render(fitted)
        if estimate(text) <= budget:
            return text, fitted
        # Shed in order of what the turn can most afford to forget. The ledger is last,
        # and folding it loses no outcome -- only the wording of old lines.
        if fitted.player_profile:
            fitted.player_profile.pop(0)
            continue
        if fitted.world_model:
            fitted.world_model.pop(0)
            continue
        if keep_recent > 0:
            keep_recent = max(0, keep_recent - LEDGER_SHED_STEP)
            continue
        return text, fitted


def _render(memory: MemoryBlocks) -> str:
    sections = [
        _world_model(memory.world_model),
        _threads(memory.threads),
        _people(memory.npcs),
        ledger_module.render(memory.ledger, memory.ledger_digest),
        _profile(memory.player_profile),
    ]
    return "\n\n".join(section for section in sections if section)


def _world_model(notes: list[str]) -> str:
    if not notes:
        return ""
    return "\n".join(
        [
            "## World model",
            "Your own notes from earlier turns. Revise any of them the moment the engine "
            "contradicts one.",
            *(f"- {note}" for note in notes),
        ]
    )


def _threads(threads: list[dict[str, Any]]) -> str:
    if not threads:
        return ""
    lines = ["## Active threads", "Quest steps as the engine tracks them."]
    for thread in threads:
        name = str(thread.get("name") or thread.get("id") or "a thread")
        ident = str(thread.get("id") or "")
        step = thread.get("step")
        total = thread.get("of")
        where = ""
        if step is not None:
            where = f"step {step}" + (f" of {total}" if total is not None else "")
        summary = str(thread.get("summary") or "").strip()
        parts = [part for part in (where, summary) if part]
        suffix = f": {' — '.join(parts)}" if parts else ""
        lines.append(f"- {name}{f' ({ident})' if ident else ''}{suffix}")
    return "\n".join(lines)


def _people(npcs: list[dict[str, Any]]) -> str:
    if not npcs:
        return ""
    lines = [
        "## People",
        "Dispositions are the engine's numbers, not yours. Change one with `set_disposition` "
        "and read the verdict; writing a different number here changes nothing.",
    ]
    for npc in npcs:
        name = str(npc.get("name") or npc.get("id") or "someone")
        ident = str(npc.get("id") or "")
        disposition = npc.get("disposition")
        goal = str(npc.get("goal") or "").strip()
        bits = []
        if disposition is not None:
            bits.append(f"disposition {disposition}")
        if goal:
            bits.append(f"wants: {goal}")
        suffix = f": {'; '.join(bits)}" if bits else ""
        lines.append(f"- {name}{f' ({ident})' if ident else ''}{suffix}")
    return "\n".join(lines)


def _profile(profile: list[str]) -> str:
    if not profile:
        return ""
    limit = CAPS["player_profile"][0]
    return "\n".join(
        [
            "## Player profile",
            "How this player likes to play. Preferences, not permissions.",
            *(f"- {note}" for note in profile[-limit:]),
        ]
    )
