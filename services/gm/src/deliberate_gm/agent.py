"""The GM agent loop.

Adapted from the ARC-AGI-3 `inference/agent/tool_agent.py` loop (see `services/gm/VENDORED.md`):
same shape -- parse tool calls, execute, feed every result back, trim history against a token
budget, keep a verified ledger of what actually happened -- with the ARC prompts and the
OpenAI-compatible transport replaced.

The loop owns no world state. Every tool call crosses to the Node server, which owns the
engine, and comes back with the engine's verdict. The loop's job is to make sure that verdict
reaches the model intact.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Any, Protocol

from .config import Settings
from .contracts import ToolContract
from .engine_client import EngineClient
from .llm import LLMClient, LLMRequest, LLMResult
from .memory import blocks as memory_blocks
from .memory import notes as memory_notes
from .models import (
    GmToolCall,
    GmToolResult,
    LedgerEntry,
    MemoryBlocks,
    ToolCallRecord,
    TurnRequest,
    TurnResponse,
    Usage,
)
from .prompt import REDACTION, build_user_message, find_leak, scan_strings, system_blocks
from .tokens import estimate_tokens

#: How a local tool reaches the engine: same door, same verdict, same trace.
NestedCall = Callable[[str, dict[str, Any]], GmToolResult]


class LocalTool(Protocol):
    """A tool this service executes itself. `nested` is how it reaches the engine."""

    def __call__(
        self,
        request: TurnRequest,
        tool_input: dict[str, Any],
        nested: NestedCall,
    ) -> GmToolResult: ...


#: Returned to the model in place of a result for calls after a rejection in the same batch.
BATCH_STOPPED = (
    "not executed: the engine rejected an earlier call in this batch, so the rest of the "
    "batch was stopped. Re-plan from that verdict."
)

#: Refused locally, before the call reaches the engine. The reason is written for the model
#: to act on, like any other verdict.
LEAK_REFUSED = (
    "not executed: this call would have carried part of your own instructions to the player. "
    "Say something in your own words instead."
)


class GmAgent:
    def __init__(
        self,
        *,
        llm: LLMClient,
        engine: EngineClient,
        contract: ToolContract,
        settings: Settings,
        local_tools: dict[str, LocalTool] | None = None,
    ) -> None:
        self._llm = llm
        self._engine = engine
        self._contract = contract
        self._tools = list(contract.tools)
        self._settings = settings
        #: Tools this service executes itself rather than forwarding to the engine (the
        #: sandboxed `python` tool). They still reach the world only through the engine.
        self._local_tools = local_tools or {}
        self._tool_names = set(contract.names())

    # -- the turn -------------------------------------------------------------------------

    def run_turn(self, request: TurnRequest) -> TurnResponse:
        memory = request.memory.model_copy(deep=True)
        system = system_blocks()
        first_message, memory = self._build_turn_message(request, memory, system)
        messages: list[dict[str, Any]] = [first_message]
        prompt_tokens = estimate_tokens(
            {"system": system, "messages": messages, "tools": self._tools}
        )

        trace: list[ToolCallRecord] = []
        redactions: list[str] = []
        usage = Usage()
        narration = ""
        stop_reason = "max_tool_steps"
        max_steps = request.max_tool_steps or self._settings.max_tool_steps

        for _ in range(max(1, max_steps)):
            messages = trim_messages(
                messages,
                budget=self._settings.input_token_budget,
                fixed=(system, self._tools),
            )
            result = self._llm.create(
                LLMRequest(system=system, messages=messages, tools=self._tools, stream=True)
            )
            _accumulate(usage, result.usage)

            messages.append({"role": "assistant", "content": result.content})
            text = result.text()
            if text.strip():
                narration = text.strip()
            self._harvest(memory, text, request)

            tool_uses = result.tool_uses()
            if not tool_uses:
                stop_reason = result.stop_reason or "end_turn"
                break

            tool_results, records = self._execute_batch(request, tool_uses, redactions)
            trace.extend(records)
            for record in records:
                entry = ledger_entry(request.turn, record)
                if entry is not None:
                    memory.ledger.append(entry)
            # Every `tool_use` block is answered, in one user message. Splitting them across
            # messages teaches the model to stop batching; dropping one breaks the exchange.
            messages.append({"role": "user", "content": tool_results})

        leak = find_leak(narration)
        if leak is not None:
            redactions.append(f"narration: {leak}")
            narration = REDACTION

        return TurnResponse(
            session=request.session,
            turn=request.turn,
            phase=request.phase,
            narration=narration,
            trace=trace,
            stop_reason=stop_reason,
            memory=memory,
            usage=usage,
            prompt_tokens_estimate=prompt_tokens,
            redactions=redactions,
        )

    # -- tool execution -------------------------------------------------------------------

    def _execute_batch(
        self,
        request: TurnRequest,
        tool_uses: list[dict[str, Any]],
        redactions: list[str],
    ) -> tuple[list[dict[str, Any]], list[ToolCallRecord]]:
        results: list[dict[str, Any]] = []
        records: list[ToolCallRecord] = []
        stopped = False

        for block in tool_uses:
            call_id = str(block.get("id", ""))
            name = str(block.get("name", ""))
            # Tool inputs are parsed, never string-matched: escaping in the serialized form
            # varies and matching on it silently misreads arguments.
            tool_input = _parse_input(block.get("input"))

            if stopped:
                results.append(_tool_result(call_id, BATCH_STOPPED, is_error=True))
                records.append(
                    ToolCallRecord(
                        call_id=call_id,
                        tool=name,
                        input=tool_input,
                        ok=False,
                        kind=self._contract.kind_of(name) or "mutation",
                        reason=BATCH_STOPPED,
                        executed=False,
                    )
                )
                continue

            leak = scan_strings(tool_input)
            if leak is not None:
                # Refused here rather than at the engine: the engine has no idea what this
                # service's prompt says, so this wall can only be built on this side.
                redactions.append(f"tool {name} argument {leak}")
                results.append(_tool_result(call_id, LEAK_REFUSED, is_error=True))
                records.append(
                    ToolCallRecord(
                        call_id=call_id,
                        tool=name,
                        input=tool_input,
                        ok=False,
                        kind=self._contract.kind_of(name) or "mutation",
                        reason=LEAK_REFUSED,
                        executed=False,
                    )
                )
                stopped = True
                continue

            started = time.monotonic()
            nested_from = len(records)
            verdict = self._dispatch(request, call_id, name, tool_input, records)
            latency_ms = int((time.monotonic() - started) * 1000)
            # The contract says what a tool is; the engine's `kind` is the fallback for
            # tools the contract does not cover, such as this service's own `python`.
            kind = self._contract.kind_of(name) or verdict.kind

            results.append(
                _tool_result(call_id, _verdict_payload(verdict), is_error=not verdict.ok)
            )
            records.append(
                ToolCallRecord(
                    call_id=call_id,
                    tool=name,
                    input=tool_input,
                    ok=verdict.ok,
                    kind=kind,
                    reason=verdict.reason,
                    diff=verdict.diff,
                    result=verdict.result,
                    latency_ms=latency_ms,
                )
            )
            # A rejected query is information. A rejected mutation invalidates the plan the
            # rest of the batch was built on, so the batch stops there -- including when the
            # rejection happened inside a local tool's nested engine call.
            rejected_nested = any(
                not record.ok and record.kind == "mutation" for record in records[nested_from:-1]
            )
            if (not verdict.ok and self._contract.is_mutation(name)) or rejected_nested:
                stopped = True

        return results, records

    def _dispatch(
        self,
        request: TurnRequest,
        call_id: str,
        name: str,
        tool_input: dict[str, Any],
        records: list[ToolCallRecord],
    ) -> GmToolResult:
        local = self._local_tools.get(name)
        if local is not None:
            # A local tool runs here, but anything it wants from the world still crosses to
            # the engine, and every crossing lands in the same trace and the same ledger.
            def nested(tool: str, payload: dict[str, Any]) -> GmToolResult:
                nested_id = f"{call_id}#{len(records)}"
                started = time.monotonic()
                verdict = self._engine_call(request, nested_id, tool, payload)
                records.append(
                    ToolCallRecord(
                        call_id=nested_id,
                        tool=tool,
                        input=payload,
                        ok=verdict.ok,
                        kind=verdict.kind,
                        reason=verdict.reason,
                        diff=verdict.diff,
                        result=verdict.result,
                        latency_ms=int((time.monotonic() - started) * 1000),
                    )
                )
                return verdict

            return local(request, tool_input, nested)
        return self._engine_call(request, call_id, name, tool_input)

    def _engine_call(
        self, request: TurnRequest, call_id: str, name: str, tool_input: dict[str, Any]
    ) -> GmToolResult:
        if name not in self._tool_names:
            return GmToolResult(
                ok=False,
                reason=f"unknown tool {name!r}; it is not in the GM tool contract",
            )
        return self._engine.call(
            GmToolCall(
                session=request.session,
                turn=request.turn,
                engine_token=request.engine_token,
                call_id=call_id,
                tool=name,
                input=tool_input,
            )
        )

    # -- memory ---------------------------------------------------------------------------

    def _build_turn_message(
        self, request: TurnRequest, memory: MemoryBlocks, system: list[dict[str, Any]]
    ) -> tuple[dict[str, Any], MemoryBlocks]:
        """Give memory whatever the budget has left after the fixed parts of the prompt.

        The system prompt, the tool schemas and the engine's state summary are not
        negotiable; the memory blocks are. Measuring the rest first is what makes the 12k
        budget a real ceiling rather than a hope.
        """
        bare = build_user_message(request, memory_text="")
        overhead = estimate_tokens({"system": system, "tools": self._tools, "messages": [bare]})
        budget = max(memory_blocks.MIN_MEMORY_TOKENS, self._settings.input_token_budget - overhead)
        memory_text, fitted = memory_blocks.render(memory, budget=budget)
        return build_user_message(request, memory_text=memory_text), fitted

    def _harvest(self, memory: MemoryBlocks, text: str, request: TurnRequest) -> None:
        """Take the model's notes into the two model-authored blocks -- and only those two.

        Threads, dispositions and the ledger come from the engine; nothing written in a reply
        can reach them. World-model notes naming an entity the engine does not have are
        dropped, so the model cannot introduce people by asserting them.
        """
        if not text.strip():
            return
        harvested = memory_notes.harvest(text)
        world_model, _dropped = memory_notes.check_entities(
            harvested["world_model"], set(request.entities)
        )
        memory.world_model = memory_notes.merge(
            memory.world_model, world_model, block="world_model"
        )
        memory.player_profile = memory_notes.merge(
            memory.player_profile, harvested["player_profile"], block="player_profile"
        )


# -- helpers ------------------------------------------------------------------------------


def ledger_entry(turn: int, record: ToolCallRecord) -> LedgerEntry | None:
    """One ledger line per attempted mutation, built from the engine's verdict.

    Queries are free and change nothing, so they leave no line. The `outcome` is taken from
    `record.ok`, which came from the engine -- never from anything the model said.
    """
    if record.kind != "mutation":
        return None
    if not record.executed:
        outcome = "not executed (batch stopped)"
    elif record.ok:
        outcome = "applied" if record.diff else "applied (no state change)"
    else:
        outcome = "rejected"
    return LedgerEntry(
        turn=turn,
        tool=record.tool,
        intent=_intent_summary(record.tool, record.input),
        ok=record.ok and record.executed,
        outcome=outcome,
        reason=record.reason,
    )


def _intent_summary(tool: str, tool_input: dict[str, Any]) -> str:
    parts = [f"{key}={_short(value)}" for key, value in sorted(tool_input.items())]
    return f"{tool}(" + ", ".join(parts) + ")"


def _short(value: Any, *, limit: int = 60) -> str:
    text = value if isinstance(value, str) else json.dumps(value, sort_keys=True)
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _parse_input(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _verdict_payload(verdict: GmToolResult) -> str:
    payload: dict[str, Any] = {"ok": verdict.ok}
    if verdict.reason:
        payload["reason"] = verdict.reason
    if verdict.diff:
        payload["diff"] = verdict.diff
    if verdict.result is not None:
        payload["result"] = verdict.result
    if verdict.state_hash:
        payload["state_hash"] = verdict.state_hash
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def _tool_result(call_id: str, content: str, *, is_error: bool) -> dict[str, Any]:
    block: dict[str, Any] = {
        "type": "tool_result",
        "tool_use_id": call_id,
        "content": content,
    }
    if is_error:
        block["is_error"] = True
    return block


def _accumulate(usage: Usage, raw: dict[str, int]) -> None:
    usage.input_tokens += int(raw.get("input_tokens", 0))
    usage.output_tokens += int(raw.get("output_tokens", 0))
    usage.cache_read_input_tokens += int(raw.get("cache_read_input_tokens", 0))
    usage.cache_creation_input_tokens += int(raw.get("cache_creation_input_tokens", 0))


def trim_messages(
    messages: list[dict[str, Any]],
    *,
    budget: int,
    fixed: tuple[Any, ...] = (),
) -> list[dict[str, Any]]:
    """Drop the oldest exchanges until the request fits the budget.

    An assistant message and the tool results answering it are one exchange and are always
    dropped together: a `tool_result` whose `tool_use` is gone is a malformed request. The
    first user message is the anchor and is never dropped -- without it there is no turn.
    """
    trimmed = list(messages)
    while len(trimmed) > 1 and estimate_tokens((fixed, trimmed)) > budget:
        # Drop the assistant turn right after the anchor, plus every message that answers it.
        end = 2
        while end < len(trimmed) and _is_tool_result_message(trimmed[end]):
            end += 1
        if end <= 1:
            break
        del trimmed[1:end]
    return trimmed


def _is_tool_result_message(message: dict[str, Any]) -> bool:
    if message.get("role") != "user":
        return False
    content = message.get("content")
    return isinstance(content, list) and all(
        isinstance(block, dict) and block.get("type") == "tool_result" for block in content
    )


__all__ = [
    "BATCH_STOPPED",
    "GmAgent",
    "LLMResult",
    "estimate_tokens",
    "ledger_entry",
    "trim_messages",
]
