"""Load the GM tool schemas.

`contracts/gm-tools.json` is the single copy of the schemas, shared with TypeScript
(docs/m1-swarm.md decision 2). This module only reads it: it never defines a schema, so the
two languages cannot drift. The file is loaded at runtime, which is why ALE-31 landing it
needs no change here.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

#: Tool names from the blueprint's game-master contract. Used to check the loaded file is
#: the file we think it is, never to define a schema.
QUERY_TOOL_NAMES = (
    "get_state",
    "legal_actions",
    "line_of_sight",
    "path",
    "recall",
    "roll_preview",
)
MUTATION_TOOL_NAMES = (
    "move",
    "attack",
    "cast",
    "say",
    "set_disposition",
    "spawn",
    "set_flag",
    "advance_quest",
    "end_turn",
)


class ContractError(RuntimeError):
    """The tool contract is missing or does not describe usable Anthropic tools."""


def load_tools(path: Path) -> list[dict[str, Any]]:
    """Read the contract and return Anthropic `tools` entries, in file order.

    Order is preserved and never sorted: the tool list is the first thing rendered into the
    request, so a stable order is what keeps the cached prefix cacheable.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ContractError(
            f"GM tool contract not found at {path}. It is owned by ALE-31; set GM_TOOLS_PATH "
            "to point at it."
        ) from exc
    except json.JSONDecodeError as exc:
        raise ContractError(f"GM tool contract at {path} is not valid JSON: {exc}") from exc

    entries = raw.get("tools") if isinstance(raw, dict) else raw
    if not isinstance(entries, list) or not entries:
        raise ContractError(f"GM tool contract at {path} has no `tools` array.")

    tools: list[dict[str, Any]] = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ContractError(f"Tool {index} in {path} is not an object.")
        tools.append(normalize_tool(entry, source=path))
    return tools


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

    return {
        "name": name,
        "description": str(entry.get("description", "")).strip(),
        "strict": True,
        "input_schema": schema,
    }


def tool_names(tools: list[dict[str, Any]]) -> tuple[str, ...]:
    return tuple(str(tool["name"]) for tool in tools)
