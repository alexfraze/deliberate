"""Deliberate's LLM game master service.

The engine (TypeScript, in the Node server) owns the rules and is the only mutator. This
service owns the agent loop and reaches the world only by calling the Node server's
`POST /gm/tool`. See `docs/gm-service.md` for the contract.
"""

__all__ = ["__version__"]

__version__ = "0.1.0"
