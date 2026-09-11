"""The leakage backstop.

The primary defence against prompt disclosure is the system prompt's own instruction not to
reveal it. This module is what catches the case where that instruction did not hold: a check
on text leaving the service, against the text that went in.

It detects *quotation*, not paraphrase. A model that restates the rules in its own words gets
through, and no string check could do better. What it reliably catches is the concrete
failure the injection bank aims at -- a player asking for the system prompt and getting some
of it back verbatim.

Two places use it: narration on the way out to the player, and the string arguments of
mutation calls on the way to the engine (an NPC's `say` line reaches the player too).
"""

from __future__ import annotations

import re

from .player_text import FENCE_CLOSE, FENCE_OPEN
from .system import SYSTEM_PROMPT

#: A run of this many consecutive words shared with the system prompt is quotation, not
#: coincidence. Twelve is long enough that ordinary prose never trips it and short enough
#: that a partial quote still does.
SHINGLE_WORDS = 12

#: Markers that should never appear in anything the player sees, whatever the wording around
#: them. The fences are prompt scaffolding; the rest are tool-protocol vocabulary.
MARKERS = (
    FENCE_OPEN,
    FENCE_CLOSE,
    "input_schema",
    "tool_use_id",
    '"type": "tool_use"',
    "additionalProperties",
)

_WORD = re.compile(r"[a-z0-9']+")

REDACTION = "[redacted: the game master tried to repeat its own instructions]"


def _words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def _shingles(words: list[str], size: int) -> set[str]:
    return {" ".join(words[i : i + size]) for i in range(len(words) - size + 1)}


_SYSTEM_SHINGLES = _shingles(_words(SYSTEM_PROMPT), SHINGLE_WORDS)


def find_leak(text: str) -> str | None:
    """Return the leaked fragment, or None. Cheap enough to run on every outgoing string."""
    if not text:
        return None
    for marker in MARKERS:
        if marker in text:
            return marker
    overlap = _shingles(_words(text), SHINGLE_WORDS) & _SYSTEM_SHINGLES
    if overlap:
        return sorted(overlap)[0]
    return None


def scan_strings(value: object, *, path: str = "") -> str | None:
    """Walk a tool input and report the first leaking string, by field path.

    Tool arguments are nested JSON, and `say(text=…)` is the obvious carrier: an NPC line is
    shown to the player exactly like narration is.
    """
    if isinstance(value, str):
        leak = find_leak(value)
        return f"{path or 'value'}: {leak}" if leak else None
    if isinstance(value, dict):
        for key, item in value.items():
            found = scan_strings(item, path=f"{path}.{key}" if path else str(key))
            if found:
                return found
        return None
    if isinstance(value, list):
        for index, item in enumerate(value):
            found = scan_strings(item, path=f"{path}[{index}]")
            if found:
                return found
    return None
