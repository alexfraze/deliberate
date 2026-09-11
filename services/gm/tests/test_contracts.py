from __future__ import annotations

import json

import pytest

from deliberate_gm.contracts import (
    MUTATION_TOOL_NAMES,
    QUERY_TOOL_NAMES,
    ContractError,
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
    names = set(tool_names(load_tools(REAL_CONTRACT)))
    assert set(QUERY_TOOL_NAMES) <= names
    assert set(MUTATION_TOOL_NAMES) <= names
