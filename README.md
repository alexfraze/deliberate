# Deliberate

A turn-based tactical RPG in the Baldur's Gate lineage where an agentic LLM game master runs the
world between your decision and the moment you press GO. **The engine owns the rules; the model
owns the story, the NPCs, and the consequences.**

- Plan and issues: [Linear project](https://linear.app/alex13-personal/project/deliberate-7019c3c7cc15)
- Design: [docs/blueprint.md](docs/blueprint.md)
- Wire protocol: [docs/protocol.md](docs/protocol.md)
- Working here as an agent: [CLAUDE.md](CLAUDE.md)

## Layout

| Package             | Role                                                                        |
| ------------------- | --------------------------------------------------------------------------- |
| `packages/protocol` | Shared contracts: snapshot, components, diffs, intents, messages, recording |
| `packages/engine`   | Rules engine. Pure, deterministic, the only thing that mutates state        |
| `packages/server`   | Fastify + WebSocket turn protocol, single in-memory room, recorder          |
| `packages/client`   | three.js renderer, isometric camera, diff-driven animation queue            |

## Commands

```sh
pnpm install
pnpm check          # typecheck + lint + format:check + test + build (what CI runs)
pnpm test           # vitest across all packages
pnpm dev:server     # Fastify on http://127.0.0.1:8787 (GET /healthz, WS /ws)
pnpm dev:client     # Vite on http://127.0.0.1:5173, proxies /ws to the server
pnpm e2e            # Playwright acceptance run: browser + server + engine + replay
pnpm replay <file>  # Re-run a recorded session and check every state hash
```

Playing locally: `pnpm dev:server` in one terminal, `pnpm dev:client` in another, then open
http://127.0.0.1:5173. Click an entity to select it, a tile to move, another entity to attack.
The server records the session to `recordings/<timestamp>.jsonl`; `pnpm replay` that file to
check it re-runs to identical hashes.

Requires Node 22 and pnpm 10 (`corepack enable`).

## Licensing

Rules content derives from the SRD 5.1 under CC-BY-4.0; see [LICENSES](LICENSES/).
