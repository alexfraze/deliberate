from __future__ import annotations

import json

import pytest

from deliberate_gm.config import Settings
from deliberate_gm.contracts import ContractError, load_contract, load_tools, tool_names

from .conftest import FIXTURE_TOOLS, REAL_CONTRACT


def test_loaded_schemas_are_closed() -> None:
    for tool in load_tools(FIXTURE_TOOLS):
        # Set rather than trusted, so a schema that forgets one still says what it accepts.
        assert tool["input_schema"]["additionalProperties"] is False, tool["name"]
        assert tool["input_schema"]["required"], tool["name"]


def test_strict_is_never_sent() -> None:
    """A live call with the real contract 400s under strict mode, two independent ways:
    `For 'integer' type, property 'minimum' is not supported`, and -- with every unsupported
    keyword stripped -- `Schema is too complex.` The engine is the authority anyway; a
    malformed call comes back as a rejected call with a reason."""
    for tool in load_tools(FIXTURE_TOOLS):
        assert "strict" not in tool, tool["name"]


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


def test_the_real_contract_loads_and_classifies_every_tool() -> None:
    """Properties of the shipped file, not a second copy of its contents.

    Which tools exist is the contract's business; that each one declares a kind, and that
    nothing the API would reject rides along, is ours.
    """
    contract = load_contract(REAL_CONTRACT)
    assert contract.tools
    for tool in contract.tools:
        name = str(tool["name"])
        assert contract.kind_of(name) in ("query", "mutation"), name
        assert set(tool) == {"name", "description", "input_schema"}, name
        assert tool["description"], name


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
    assert set(contract.tools[0]) == {"name", "description", "input_schema"}
    assert contract.kind_of("attack") == "mutation"


def test_a_tool_without_a_kind_is_refused(tmp_path) -> None:
    """Loudly, rather than guessed at. A misclassified mutation would let a rejected change
    go unnoticed while the rest of the batch proceeded on it."""
    path = tmp_path / "gm-tools.json"
    path.write_text(
        json.dumps(
            {"tools": [{"name": "attack", "description": "d", "input_schema": {"type": "object"}}]}
        )
    )
    with pytest.raises(ContractError, match="has no `kind`"):
        load_contract(path)


def test_a_duplicate_tool_is_refused(tmp_path) -> None:
    path = tmp_path / "gm-tools.json"
    entry = {
        "name": "attack",
        "kind": "mutation",
        "description": "d",
        "input_schema": {"type": "object"},
    }
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


def test_default_settings_find_the_contract_from_anywhere() -> None:
    """`Settings()` and `Settings.from_env()` must resolve the same file.

    The default used to be the relative `contracts/gm-tools.json`, which only worked when the
    service happened to be started from the repository root -- and silently degraded to a 503
    saying the contract was missing when it was not.
    """
    assert Settings().tools_path == Settings.from_env().tools_path
    assert Settings().tools_path.is_absolute()
    assert Settings().tools_path == REAL_CONTRACT
