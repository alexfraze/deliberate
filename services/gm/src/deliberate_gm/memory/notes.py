"""Harvesting the model-authored memory blocks, and checking them against the engine.

Two of the five blocks are the model's own: the world model and the player profile. The model
writes them by putting labelled lines in its reply, which the loop harvests -- the note
harvesting from the ARC-AGI-3 agent, with ARC's seven "scientist note" fields cut down to the
two this game has a use for.

The other three blocks are not harvestable at all. Threads, NPC dispositions and the ledger
come from the engine, and nothing the model writes can reach them. A world-model note that
names an entity the engine has never heard of is dropped, so the model cannot furnish itself
with people who do not exist.
"""

from __future__ import annotations

import re

#: A line that opens with a short `Label:` is a label line, recognised or not. An unrecognised
#: one still ends the previous note, so a model cannot smuggle text into a model-authored
#: block by writing it under an engine-owned-looking heading like `Ledger:`.
LABEL_LINE = re.compile(r"^([A-Za-z][A-Za-z ]{0,30}):(.*)$")

#: Entity ids look like `pc:ari` or `npc:gorm`. Anything of that shape in a note is checked.
ENTITY_REF = re.compile(r"\b([a-z][a-z0-9_]*:[A-Za-z0-9_.\-]+)")

#: The labels the model may write. Anything else it writes is narration, not memory.
LABELS = {
    "world model": "world_model",
    "player": "player_profile",
}

CAPS = {
    "world_model": (12, 240),
    "player_profile": (8, 160),
}


def harvest(text: str) -> dict[str, list[str]]:
    """Pull labelled note lines out of one model reply.

    A label starts a note and everything until the next label or blank line belongs to it, so
    a note can run to a second line without needing the model to repeat the label.
    """
    found: dict[str, list[str]] = {key: [] for key in CAPS}
    current: str | None = None
    buffer: list[str] = []

    def flush() -> None:
        nonlocal current, buffer
        if current and buffer:
            note = " ".join(" ".join(buffer).split())
            if note:
                found[current].append(note)
        current, buffer = None, []

    for raw_line in (text or "").splitlines():
        line = raw_line.strip().lstrip("-*").strip()
        if not line:
            flush()
            continue
        match = LABEL_LINE.match(line)
        if match is not None:
            label, rest = match.group(1), match.group(2)
            flush()
            current = LABELS.get(label.strip().lower())
            if current is not None and rest.strip():
                buffer.append(rest.strip())
            continue
        if current is not None:
            buffer.append(line)
    flush()
    return found


def check_entities(notes: list[str], entities: set[str]) -> tuple[list[str], list[str]]:
    """Split notes into those the engine can vouch for and those it cannot.

    A note with no entity reference is kept: plenty of true things about a world name nobody.
    A note that references an id the engine does not have is dropped whole -- half a note is
    worse than none, because the model would read the remainder as confirmed.
    """
    kept: list[str] = []
    dropped: list[str] = []
    for note in notes:
        referenced = set(ENTITY_REF.findall(note))
        (dropped if referenced - entities else kept).append(note)
    return kept, dropped


def merge(existing: list[str], new: list[str], *, block: str) -> list[str]:
    """Add new notes, drop exact repeats, and keep the block under its cap.

    Newest wins when the cap bites: a stale note is the one the model is least likely to
    still believe.
    """
    limit, max_chars = CAPS[block]
    merged = list(existing)
    for note in new:
        trimmed = note if len(note) <= max_chars else note[: max_chars - 1].rstrip() + "…"
        if trimmed in merged:
            merged.remove(trimmed)
        merged.append(trimmed)
    return merged[-limit:]
