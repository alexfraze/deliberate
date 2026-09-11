"""Load the GM tool schemas.

`contracts/gm-tools.json` is the single copy of the schemas, shared with TypeScript
(docs/m1-swarm.md decision 2). This module only reads it: it never defines a schema, so the
two languages cannot drift. The file is loaded at runtime, so ALE-31 landing it needs no
change here.

The envelope is `{"version": 1, "tools": [...]}` (a bare array also works). Entries carry a
`"kind"` of `"query"` or `"mutation"`, and the loader keeps that classification rather than
discarding it: the agent loop needs it, because a mutation's `tool_result` is an engine
verdict that invalidates the rest of a batch when it comes back rejected, while a query's is
just data.

`kind` is stripped before the entry reaches the Anthropic `tools` parameter, which takes only
`{name, description, input_schema}`.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

ToolKind = Literal["query", "mutation"]


class ContractError(RuntimeError):
    """The tool contract is missing or does not describe usable Anthropic tools."""


@dataclass(frozen=True)
class ToolContract:
    """The tools the model may call, and which of them change the world.

    `tools` is in the order the model sees, and that order never varies for a given contract
    file: the tool list is the first thing rendered into a request, so a stable order is what
    keeps the cached prefix cacheable.
    """

    tools: tuple[dict[str, Any], ...]
    kinds: Mapping[str, ToolKind]

    def names(self) -> tuple[str, ...]:
        return tuple(str(tool["name"]) for tool in self.tools)

    def kind_of(self, name: str) -> ToolKind | None:
        return self.kinds.get(name)

    def is_mutation(self, name: str) -> bool:
        """Unknown tools count as mutations.

        Guessing wrong in this direction costs a halted batch; guessing wrong in the other
        would let a rejected change go unnoticed and the rest of the plan proceed on it.
        """
        return self.kinds.get(name) != "query"

    def with_tool(self, definition: dict[str, Any], *, kind: ToolKind) -> ToolContract:
        """Add a tool this service owns (the sandboxed `python` tool), after the contract's."""
        normalized = normalize_tool(definition, source="<service>")
        return ToolContract(
            tools=(*self.tools, normalized),
            kinds={**self.kinds, normalized["name"]: kind},
        )


def load_contract(path: Path) -> ToolContract:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ContractError(
            f"GM tool contract not found at {path}. It is owned by ALE-31; set GM_TOOLS_PATH "
            "to point at it."
        ) from exc
    except json.JSONDecodeError as exc:
        raise ContractError(f"GM tool contract at {path} is not valid JSON: {exc}") from exc

    tools: list[dict[str, Any]] = []
    kinds: dict[str, ToolKind] = {}
    for index, entry in enumerate(_entries(raw, path)):
        if not isinstance(entry, dict):
            raise ContractError(f"Tool {index} in {path} is not an object.")
        tool = normalize_tool(entry, source=path)
        name = str(tool["name"])
        if name in kinds:
            raise ContractError(f"Tool {name!r} appears twice in {path}.")
        tools.append(tool)
        kinds[name] = _kind_of(entry, name, path)
    if not tools:
        raise ContractError(f"GM tool contract at {path} describes no tools.")
    return ToolContract(tools=tuple(tools), kinds=kinds)


def _entries(raw: Any, path: Path) -> list[Any]:
    if isinstance(raw, list):
        return raw
    if not isinstance(raw, dict):
        raise ContractError(f"GM tool contract at {path} is neither an object nor an array.")
    entries = raw.get("tools")
    if not isinstance(entries, list):
        raise ContractError(f"GM tool contract at {path} has no `tools` array.")
    return entries


def _kind_of(entry: dict[str, Any], name: str, source: Path) -> ToolKind:
    """Read the entry's own `kind`. The contract file is the only place this is written down.

    A missing or unrecognised `kind` is an error rather than a guess. A name list here would
    be a second copy of a fact the contract owns, in a second language, and a tool added on
    one side would have to be remembered on the other — which is the drift the single-file
    contract exists to prevent.
    """
    declared = str(entry.get("kind", "")).strip().lower()
    if declared in ("query", "mutation"):
        return "query" if declared == "query" else "mutation"
    raise ContractError(
        f'Tool {name!r} in {source} has no `kind`. Every entry must declare "query" or '
        '"mutation": the loop stops a batch at the first rejected mutation and lets a '
        "rejected query pass, and it has no other way to tell them apart."
    )


def load_tools(path: Path) -> list[dict[str, Any]]:
    """The Anthropic `tools` entries alone, for callers that do not need the classification."""
    return list(load_contract(path).tools)


def normalize_tool(entry: dict[str, Any], *, source: Path | str = "<memory>") -> dict[str, Any]:
    """Turn one contract entry into an Anthropic tool definition.

    `strict` is a top-level field on the tool (not on `tool_choice`), and strict mode
    requires `additionalProperties: false` plus `required`. We set all three rather than
    trusting the file, so a schema that forgets one still gets validated arguments.
    """
    name = str(entry.get("name", "")).strip()
    if not name:
        raise ContractError(f"A tool in {source} has no name.")
    schema = entry.get("input_schema") or entry.get("inputSchema")
    if not isinstance(schema, dict):
        raise ContractError(f"Tool {name!r} in {source} has no object `input_schema`.")

    schema = json.loads(json.dumps(schema))  # defensive copy; never mutate the caller's dict
    schema.setdefault("type", "object")
    schema["additionalProperties"] = False
    schema.setdefault("required", sorted(schema.get("properties", {})))

    # Built from scratch rather than copied and pruned, so contract-only fields -- `kind`,
    # `$comment`, anything ALE-31 adds later -- can never reach the API, where an unexpected
    # key is a 400.
    return {
        "name": name,
        "description": str(entry.get("description", "")).strip(),
        "strict": True,
        "input_schema": schema,
    }


def tool_names(tools: list[dict[str, Any]]) -> tuple[str, ...]:
    return tuple(str(tool["name"]) for tool in tools)
