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
        "time, and narrate what the engine's verdicts say happened."
    ),
    "narrate": (
        "The engine has already resolved this turn. Narrate what its diffs say happened. "
        "Make no mutation calls."
    ),
}

#: Appended to the resolve task only when `TurnRequest.want_policy` is set (ALE-37).
#:
#: It is a separate string, and asked for separately, because writing a policy is not free: the
#: one live resolve in the ALE-37 measurement run took 33 s against the baseline's 19 s, and the
#: difference is the model writing a program as well as taking a turn. Paying that on the *first*
#: time an NPC acts buys nothing if it never acts again -- so Node asks only once it has seen
#: this NPC in this situation before, which is the earliest evidence that a third turn is coming.
POLICY_TASK = (
    "\n\nThis NPC has now come round in this situation more than once, so write down how it "
    "fights it: call `save_policy` with a Python program that takes this NPC's turn from "
    "`state`, and the server will run that instead of asking you again. Write the strategy, "
    "not this turn's move -- it re-runs from scratch every turn, against whatever the world "
    "looks like then, so read positions, hit points and who is alive out of `state` rather "
    "than assuming any of them."
)


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

    task = PHASE_TASK.get(request.phase, PHASE_TASK["preview"])
    if request.want_policy and request.phase == "resolve":
        task += POLICY_TASK
    sections.append("## Your task\n" + task)

    return {"role": "user", "content": "\n\n".join(sections)}


def _json_block(value: Any) -> str:
    # sort_keys keeps the rendering deterministic, so an unchanged block stays byte-identical
    # across turns and replays.
    return "```json\n" + json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n```"
