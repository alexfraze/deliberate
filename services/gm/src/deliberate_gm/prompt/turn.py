"""The volatile half of the prompt: one user message per turn."""

from __future__ import annotations

import json
from typing import Any

from ..models import TurnRequest
from .player_text import quote_player_speech

PHASE_TASK = {
    "preview": (
        "Work out what this intent would do and what the world would do back. Read state "
        "with the query tools, then make the mutation calls the turn actually requires. "
        "Narrate the result in a few sentences."
    ),
    "resolve": (
        "Initiative is running. Act for the entity named by `acting`, one validated call at a "
        "time, and narrate what the engine's verdicts say happened.\n"
        "\n"
        "Then save a policy for that NPC with `save_policy`, so the server can take its later "
        "turns without asking you (ALE-37). You are being asked because there is no usable "
        "policy for this NPC in this situation -- either it has never had one, the situation "
        "has changed under it, or the one it had stopped working. Write the strategy you just "
        "used, generally enough that it still reads correctly two turns from now when everyone "
        "has moved."
    ),
    "narrate": (
        "The engine has already resolved this turn. Narrate what its diffs say happened. "
        "Make no mutation calls."
    ),
}


def build_user_message(request: TurnRequest, *, memory_text: str = "") -> dict[str, Any]:
    """Assemble the turn message. Never contains anything that belongs in the system prompt."""
    sections: list[str] = [f"# Turn {request.turn} — {request.phase}"]

    if memory_text:
        sections.append(memory_text)

    if request.state:
        sections.append("## Engine state\n" + _json_block(request.state))

    if request.player_intent is not None:
        sections.append(
            "## The player's chosen intent\nThe UI composed this; the engine will still "
            "validate it.\n" + _json_block(request.player_intent)
        )

    speech = quote_player_speech(request.player_text)
    if speech:
        sections.append(speech)

    sections.append("## Your task\n" + PHASE_TASK.get(request.phase, PHASE_TASK["preview"]))

    return {"role": "user", "content": "\n\n".join(sections)}


def _json_block(value: Any) -> str:
    # sort_keys keeps the rendering deterministic, so an unchanged block stays byte-identical
    # across turns and replays.
    return "```json\n" + json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n```"
