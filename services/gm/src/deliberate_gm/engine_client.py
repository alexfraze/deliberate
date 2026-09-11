"""The only door into the engine.

Everything the GM wants to know or change goes through `POST /gm/tool` on the Node server.
A transport failure is reported as a rejected call, not raised: the loop must still return a
`tool_result` for every `tool_use` block the model emitted, and dropping one corrupts the
conversation.
"""

from __future__ import annotations

from typing import Protocol

import httpx

from .models import GmToolCall, GmToolResult


class EngineClient(Protocol):
    def call(self, call: GmToolCall) -> GmToolResult: ...


class HttpEngineClient:
    """Talks to the Node game server. Localhost round trips against an 8 s preview budget."""

    def __init__(self, base_url: str, *, timeout: float = 10.0, client: httpx.Client | None = None):
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._client = client or httpx.Client(timeout=timeout)

    def call(self, call: GmToolCall) -> GmToolResult:
        try:
            response = self._client.post(
                f"{self._base_url}/gm/tool",
                json=call.model_dump(mode="json"),
                timeout=self._timeout,
            )
        except httpx.HTTPError as exc:
            return GmToolResult(ok=False, reason=f"engine unreachable: {exc.__class__.__name__}")

        if response.status_code >= 400:
            return GmToolResult(
                ok=False,
                reason=f"engine rejected the request with HTTP {response.status_code}",
            )
        try:
            payload = response.json()
        except ValueError:
            return GmToolResult(ok=False, reason="engine returned a non-JSON response")
        if not isinstance(payload, dict):
            return GmToolResult(ok=False, reason="engine returned a non-object response")
        return GmToolResult.model_validate(payload)

    def close(self) -> None:
        self._client.close()
