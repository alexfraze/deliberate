"""The Node <-> Python wire shapes. Documented for humans in `docs/gm-service.md`.

Two directions:

* Node -> Python: `POST /turn` with a `TurnRequest`, answered with a `TurnResponse`.
* Python -> Node: `POST /gm/tool` with a `GmToolCall`, answered with a `GmToolResult`.

The second direction is the only door into the engine. This service holds no world state,
computes no rules, and never decides whether a call is legal.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

Phase = Literal["preview", "resolve", "narrate"]


class LedgerEntry(BaseModel):
    """One engine-generated line: what was attempted, and what the engine decided.

    Generated from the engine's verdict, never from the model's account of it. A model that
    claims it hit cannot enter that claim here.
    """

    turn: int
    tool: str
    intent: str
    ok: bool
    outcome: str
    reason: str | None = None


class MemoryBlocks(BaseModel):
    """Prompt memory, re-injected every turn.

    The service is stateless: Node sends the blocks in and gets the updated blocks back, and
    persists them with the recording so a replay reproduces the same prompt.
    """

    world_model: list[str] = Field(default_factory=list)
    threads: list[dict[str, Any]] = Field(default_factory=list)
    npcs: list[dict[str, Any]] = Field(default_factory=list)
    ledger: list[LedgerEntry] = Field(default_factory=list)
    player_profile: list[str] = Field(default_factory=list)


class TurnRequest(BaseModel):
    session: str
    turn: int
    phase: Phase = "preview"
    #: Opaque handle for the engine instance to act on. Preview runs against a clone, so the
    #: token is how Node keeps a speculative turn off the real engine; Python just echoes it.
    engine_token: str | None = None
    #: A read-only state summary the engine already computed. Not authoritative, not cached.
    state: dict[str, Any] = Field(default_factory=dict)
    #: Entity ids the world model is allowed to reference. Engine-supplied.
    entities: list[str] = Field(default_factory=list)
    #: The player's chosen intent, already shaped by the UI.
    player_intent: dict[str, Any] | None = None
    #: Free player text. Enters the prompt as quoted data, never as instruction (ALE-33).
    player_text: str | None = None
    memory: MemoryBlocks = Field(default_factory=MemoryBlocks)
    max_tool_steps: int | None = None


class GmToolCall(BaseModel):
    """Python -> Node. One tool call, exactly as the model emitted it."""

    session: str
    turn: int
    engine_token: str | None = None
    call_id: str
    tool: str
    input: dict[str, Any] = Field(default_factory=dict)


class GmToolResult(BaseModel):
    """Node -> Python. The engine's answer. `{ok, reason, diff}` from the blueprint, plus
    `kind` so the ledger knows a mutation from a free query, and `result` for queries."""

    ok: bool
    kind: Literal["query", "mutation"] = "mutation"
    reason: str | None = None
    diff: list[dict[str, Any]] = Field(default_factory=list)
    result: Any = None
    state_hash: str | None = None


class ToolCallRecord(BaseModel):
    """One line of the turn's trace: the call, and the engine's verdict on it."""

    call_id: str
    tool: str
    input: dict[str, Any] = Field(default_factory=dict)
    ok: bool
    kind: Literal["query", "mutation"] = "mutation"
    reason: str | None = None
    diff: list[dict[str, Any]] = Field(default_factory=list)
    result: Any = None
    executed: bool = True
    latency_ms: int = 0


class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0


class TurnResponse(BaseModel):
    session: str
    turn: int
    phase: Phase
    narration: str
    trace: list[ToolCallRecord] = Field(default_factory=list)
    stop_reason: str
    #: The blocks Node should persist for the next turn.
    memory: MemoryBlocks = Field(default_factory=MemoryBlocks)
    usage: Usage = Field(default_factory=Usage)
    #: What the assembled prompt cost, so a session can be watched against the 12k budget.
    prompt_tokens_estimate: int = 0
