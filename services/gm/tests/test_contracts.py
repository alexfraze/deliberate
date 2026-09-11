from __future__ import annotations

import json

import pytest

from deliberate_gm.contracts import (
    MUTATION_TOOL_NAMES,
    QUERY_TOOL_NAMES,
    ContractError,
    load_contract,
    load_tools,
    tool_names,
)

from .conftest import FIXTURE_TOOLS, REAL_CONTRACT


def test_loaded_tools_are_strict_and_closed() -> None:
    for tool in load_tools(FIXTURE_TOOLS):
        assert tool["strict"] is True, tool["name"]
        # strict mode requires both of these; we set them rather than trust the file.
        assert tool["input_schema"]["additionalProperties"] is False, tool["name"]
        assert tool["input_schema"]["required"], tool["name"]


def test_tool_order_is_the_file_order() -> None:
    raw = json.loads(FIXTURE_TOOLS.read_text())
    assert tool_names(load_tools(FIXTURE_TOOLS)) == tuple(t["name"] for t in raw["tools"])


def test_missing_contract_names_the_owner(tmp_path) -> None:
    with pytest.raises(ContractError, match="ALE-31"):
        load_tools(tmp_path / "nope.json")


def test_normalizing_does_not_mutate_the_source_schema() -> None:
    raw = json.loads(FIXTURE_TOOLS.read_text())
    before = json.dumps(raw, sort_keys=True)
    load_tools(FIXTURE_TOOLS)
    assert json.dumps(json.loads(FIXTURE_TOOLS.read_text()), sort_keys=True) == before


@pytest.mark.skipif(not REAL_CONTRACT.exists(), reason="contracts/gm-tools.json is ALE-31's")
def test_real_contract_covers_the_blueprint_tools() -> None:
    """Starts enforcing the moment ALE-31 lands the file; nothing here changes then."""
    contract = load_contract(REAL_CONTRACT)
    names = set(contract.names())
    assert set(QUERY_TOOL_NAMES) <= names
    assert set(MUTATION_TOOL_NAMES) <= names
    # Whatever else the file says, the entries the API sees carry only what the API takes.
    for tool in contract.tools:
        assert set(tool) == {"name", "description", "strict", "input_schema"}, tool["name"]


def test_kind_comes_from_the_entry() -> None:
    contract = load_contract(FIXTURE_TOOLS)
    assert contract.kind_of("get_state") == "query"
    assert contract.kind_of("attack") == "mutation"
    assert contract.is_mutation("attack") is True
    assert contract.is_mutation("get_state") is False


def test_an_unknown_tool_counts_as_a_mutation() -> None:
    """Guessing wrong this way costs a halted batch. Guessing wrong the other way would let
    a rejected change go unnoticed and the rest of the plan proceed on it."""
    assert load_contract(FIXTURE_TOOLS).is_mutation("delete_everything") is True


def test_contract_only_fields_never_reach_the_api(tmp_path) -> None:
    path = tmp_path / "gm-tools.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "tools": [
                    {
                        "name": "attack",
                        "kind": "mutation",
                        "description": "d",
                        "notes": "internal",
                        "input_schema": {"type": "object", "properties": {"a": {"type": "string"}}},
                    }
                ],
            }
        )
    )
    contract = load_contract(path)
    assert set(contract.tools[0]) == {"name", "description", "strict", "input_schema"}
    assert contract.kind_of("attack") == "mutation"


def test_a_contract_without_kind_still_loads(tmp_path) -> None:
    """Transitional: classification falls back to the blueprint name lists."""
    path = tmp_path / "gm-tools.json"
    path.write_text(
        json.dumps(
            {
                "tools": [
                    {"name": "get_state", "description": "d", "input_schema": {"type": "object"}},
                    {"name": "attack", "description": "d", "input_schema": {"type": "object"}},
                ]
            }
        )
    )
    contract = load_contract(path)
    assert contract.kind_of("get_state") == "query"
    assert contract.kind_of("attack") == "mutation"


def test_a_duplicate_tool_is_refused(tmp_path) -> None:
    path = tmp_path / "gm-tools.json"
    entry = {"name": "attack", "description": "d", "input_schema": {"type": "object"}}
    path.write_text(json.dumps({"tools": [entry, entry]}))
    with pytest.raises(ContractError, match="appears twice"):
        load_contract(path)


def test_the_service_tool_is_added_after_the_contracts() -> None:
    contract = load_contract(FIXTURE_TOOLS)
    extended = contract.with_tool(
        {"name": "python", "description": "d", "input_schema": {"type": "object"}}, kind="query"
    )
    assert extended.names()[-1] == "python"
    assert extended.kind_of("python") == "query"
    # The original is untouched: the contract is frozen data, not a mutable registry.
    assert "python" not in contract.names()
