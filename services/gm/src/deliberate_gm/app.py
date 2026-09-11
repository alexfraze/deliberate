"""The GM service's HTTP surface.

`POST /turn` is the whole contract from Node's side: hand over the turn, get narration, the
tool-call trace with the engine's verdicts, and the updated memory blocks back. See
`docs/gm-service.md`.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException

from .agent import GmAgent
from .config import Settings, live_api_available
from .contracts import ContractError, ToolContract, load_contract
from .engine_client import HttpEngineClient
from .llm import AnthropicLLM, LLMUnavailable
from .models import TurnRequest, TurnResponse
from .python_tool import PYTHON_TOOL, PYTHON_TOOL_NAME, make_python_tool
from .stub_engine import StubEngine


def create_app(
    settings: Settings | None = None,
    *,
    llm: Any | None = None,
    engine: Any | None = None,
) -> FastAPI:
    """Build the app. `llm` and `engine` are injected by tests and by the stub setup; in
    production both are resolved from settings."""
    settings = settings or Settings.from_env()
    app = FastAPI(title="Deliberate GM", version="0.1.0")
    state: dict[str, Any] = {"contract": None}

    def resolve_contract() -> ToolContract:
        if state["contract"] is None:
            try:
                contract = load_contract(settings.tools_path)
            except ContractError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
            # Contract order first, then the service's own tool. Deterministic, so the
            # rendered tool block stays byte-identical and the cache prefix holds. `python`
            # is a query: it reads and computes, and anything it wants to change still goes
            # through the engine as its own validated call.
            if settings.python_tool_enabled:
                contract = contract.with_tool(PYTHON_TOOL, kind="query")
            state["contract"] = contract
        contract = state["contract"]
        assert isinstance(contract, ToolContract)
        return contract

    def resolve_engine() -> Any:
        if engine is not None:
            return engine
        if settings.engine_url == "stub":
            return StubEngine()
        return HttpEngineClient(settings.engine_url, timeout=settings.engine_timeout_seconds)

    def resolve_llm() -> Any:
        if llm is not None:
            return llm
        if not live_api_available():
            raise HTTPException(
                status_code=503,
                detail=(
                    "No Claude credentials: set ANTHROPIC_API_KEY to run a live turn, or "
                    "inject a scripted client with create_app(llm=...)."
                ),
            )
        return AnthropicLLM(settings)

    @app.get("/healthz")
    def healthz() -> dict[str, Any]:
        try:
            loaded = resolve_contract()
            tools = loaded.names()
            kinds = dict(loaded.kinds)
            status = "loaded"
        except HTTPException:
            tools, kinds, status = (), {}, "missing"
        return {
            "ok": True,
            "model": settings.model,
            "effort": settings.effort,
            "contract": status,
            "tools": list(tools),
            "tool_kinds": kinds,
            "engine": settings.engine_url,
            "live_api": live_api_available(),
        }

    @app.post("/turn", response_model=TurnResponse)
    def turn(request: TurnRequest) -> TurnResponse:
        contract = resolve_contract()
        local_tools = (
            {PYTHON_TOOL_NAME: make_python_tool(timeout_seconds=settings.python_timeout_seconds)}
            if settings.python_tool_enabled
            else {}
        )
        agent = GmAgent(
            llm=resolve_llm(),
            engine=resolve_engine(),
            contract=contract,
            settings=settings,
            local_tools=local_tools,
        )
        try:
            return agent.run_turn(request)
        except LLMUnavailable as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    return app


app = create_app()
