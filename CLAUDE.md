# CLAUDE.md

Deliberate: a turn-based tactical RPG where an LLM game master runs the world between your
decision and GO, over an engine that owns the rules. Design in `docs/blueprint.md`; issues in the
[Linear project](https://linear.app/alex13-personal/project/deliberate-7019c3c7cc15) (team key
`ALE`). The M0 launch plan is `docs/m0-swarm.md`.

## Non-negotiables

- **Engine authority.** Only `packages/engine` mutates world state, only through validated
  intents, and every mutation emits typed diffs. The server and client never edit a snapshot.
- **Determinism.** The engine never calls `Math.random` (lint-enforced), `Date.now()`, or anything
  platform-dependent. Rolls come from the seeded `Rng`. Same seed and same intents must replay to
  identical state hashes; that is the M0 exit criterion and the M3 regression suite.
- **Client never holds authoritative state.** It renders the last `snapshot` plus the `diffs`
  stream and sends `intent`s. It does not depend on `@deliberate/engine`.
- **Contracts live in `packages/protocol`.** Import shapes from there; never redefine them. Changes
  there are cross-cutting: additive, minimal, and called out in the PR description.

## Layout and ownership

| Path                                  | Linear | Notes                                                      |
| ------------------------------------- | ------ | ---------------------------------------------------------- |
| `packages/protocol/src/`              | shared | Types and constants only. See rule above.                  |
| `packages/engine/src/grid,store,hash` | ALE-8  | Grid math, entity store, Blake2 state hash, `createEngine` |
| `packages/engine/src/rules`           | ALE-9  | SRD 5.1 trimmed rules, action economy, initiative          |
| `packages/engine/src/diffs`           | ALE-10 | Diff emission, `apply(snapshot, diffs)`                    |
| `packages/engine/src/recorder`        | ALE-30 | JSONL recorder, `replay`, the regression bank runner       |
| `recordings/bank/`                    | ALE-21 | The replay regression bank; `docs/regression-bank.md`      |
| `packages/engine/src/engine.ts`       | seam   | `Engine` interface consumed by server and recorder         |
| `packages/server/`                    | ALE-11 | Fastify + WebSocket, single room, drives an `Engine`       |
| `packages/client/`                    | ALE-12 | three.js renderer, diff-driven animation queue             |
| `docs/protocol.md`                    | ALE-11 | Human-readable protocol                                    |

Stay inside your area. If you need something from another area, code against its interface
(`Engine`, the protocol types) and test with a fake; do not implement it yourself.

## Commands

```sh
pnpm install                # once; the SessionStart hook does this in cloud sessions
pnpm check                  # typecheck + lint + format:check + test + build (CI runs exactly this)
pnpm test                   # vitest, all packages
pnpm --filter @deliberate/engine test   # one package
pnpm format                 # prettier --write; run before committing
pnpm dev:server             # http://127.0.0.1:8787, GET /healthz, WS /ws
pnpm dev:client             # http://127.0.0.1:5173, proxies /ws to the server
pnpm e2e                    # Playwright acceptance run (needs a browser; not part of `check`)
pnpm replay <file.jsonl>    # Re-run a recorded session and check every state hash
pnpm bank                   # Replay the whole regression bank (docs/regression-bank.md)
```

Node 22, pnpm 10, ESM everywhere, strict TypeScript. Playwright with Chromium is available in
cloud sessions for end-to-end checks (`/opt/pw-browsers`, do not run `playwright install`).

## Conventions

- Tests are colocated `*.test.ts`, vitest. Property tests use `fast-check` (already a dev dep)
  with a seeded `Rng` so failures reproduce.
- No new dependencies without a sentence in the PR explaining why. Never hand-edit
  `pnpm-lock.yaml`.
- Blake2 comes from Node's `crypto.createHash('blake2b512')`; no hashing library.
- Prefer small pure functions over classes in the engine. Snapshots are plain JSON; `structuredClone`
  them, never hand out live references.
- Every rejected intent returns a `Verdict` whose `reason` a player could read on screen.

## Git and PRs

- One Linear issue per branch and PR. Use the branch name Linear generates
  (`alexfraze/ale-<n>-<slug>`); the PR title starts with `ALE-<n>:`.
- Branch from `main`, keep the PR green (`pnpm check`), rebase on `main` before opening.
- PR description: what was built, how it was verified, any contract change, anything you left for
  the acceptance issue (ALE-13). If Linear tools are available, move the issue to In Progress when
  you start and In Review when the PR is open; otherwise note the state in the PR.
- Do not merge your own PR unless the repo has auto-merge enabled and CI is green.
