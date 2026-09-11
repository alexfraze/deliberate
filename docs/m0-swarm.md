# M0 swarm launch plan

Goal: milestone **M0 Skeleton without a model** (Linear, target 2026-09-19) built overnight by
parallel agents, each on one Linear issue, each opening one PR against `main`.

M0 exit (ALE-13): move and attack through the UI with no model in the loop, the engine rejects
illegal moves with a visible reason, the session records to JSONL and replays to identical hashes.

## Dependency graph (from Linear relations)

```
ALE-8  grid + store + hash ──┬──▶ ALE-9  rules engine ─────────────┐
                             └──▶ ALE-10 diff events ──▶ ALE-30 recorder ─┤
ALE-11 websocket protocol ────────────────────────────────────────────┼──▶ ALE-13 acceptance
ALE-12 three.js client ───────────────────────────────────────────────┘
```

The scaffold breaks the hard edges: shapes are fixed in `packages/protocol`, and the `Engine`
interface in `packages/engine/src/engine.ts` is the seam everyone codes against. That lets the
chains run as two sequential agents instead of four waiting waves.

## Agents

| Agent | Issues (in order)   | Owns                                                 | Points |
| ----- | ------------------- | ---------------------------------------------------- | ------ |
| A     | ALE-8, then ALE-9   | `engine/src/{grid,store,hash,rules}`, `createEngine` | 8      |
| B     | ALE-10, then ALE-30 | `engine/src/{diffs,recorder}`                        | 4      |
| C     | ALE-11              | `packages/server`, `docs/protocol.md`                | 3      |
| D     | ALE-12              | `packages/client`                                    | 5      |
| E     | ALE-13              | `e2e/` (Playwright), wiring, fixture map             | 1      |

A–D run in parallel tonight. E runs after A–D are merged (morning, or an orchestrator that waits).
A is the critical path; if only one agent could run, it would be A.

Shared files that can conflict: `packages/engine/src/index.ts` (A and B both add exports; trivial
to resolve) and `pnpm-lock.yaml` (only if someone adds a dependency; `fast-check` and `ws` are
already in). Everything else is disjoint by construction.

## Pre-flight (Alex, five minutes)

0. Install the Claude GitHub App on `alexfraze/deliberate`
   (https://github.com/apps/claude/installations/select_target). Without it cloud sessions can
   read the repo and open PRs through the API but every `git push` is refused with a 403, which
   is exactly where each swarm agent would stall.
1. `main` must exist with the scaffold on it and be the default branch.
2. GitHub → Settings → General → enable **Allow auto-merge** and **Automatically delete head
   branches**.
3. GitHub → Settings → Branches → add a rule for `main`: require the `check` status check to pass.
   Do not require reviews (nobody is awake to give them). Agents can then enable auto-merge on
   their own PRs and the night runs itself.
4. Launch four cloud sessions on `alexfraze/deliberate` with the prompts below (environment
   `alex-cloud`, permission mode that allows pushes). Attach the Linear connector if you want
   issue status kept current; it is optional.
5. Optional: a fifth session with the E prompt, told to wait for the four PRs to merge (it will
   poll `main`). Otherwise launch E in the morning.

Anthropic API keys, Blender, GPUs, and the ARC-AGI-3 code are **not** needed for M0.

## Morning checklist

- Four PRs green and merged; `pnpm check` on `main` passes.
- `pnpm dev:server` + `pnpm dev:client`: join, move, attack, illegal move shows a reason.
- A recording exists under `recordings/` and `pnpm --filter @deliberate/engine exec tsx src/recorder/cli.ts replay <file>` (or whatever ALE-30 shipped) passes.
- ALE-13 open or done; move M0 issues to Done in Linear.

---

## Prompts

Every prompt assumes the session starts on `main` of `alexfraze/deliberate` and that the agent
reads `CLAUDE.md`, `docs/blueprint.md`, and the Linear issue before writing code.

### Agent A — ALE-8 then ALE-9 (engine core)

```
You are implementing two Linear issues in alexfraze/deliberate, in order, one PR each:
ALE-8 "M0: Tile grid + entity store" and then ALE-9 "M0: Rules engine core (SRD 5.1 trimmed)".
Read CLAUDE.md, docs/blueprint.md, and both Linear issues first. Work only inside
packages/engine/src/{grid,store,hash,rules} plus packages/engine/src/index.ts exports. Import every
shape from @deliberate/protocol; do not redefine them. Do not touch packages/server or
packages/client.

ALE-8, branch alexfraze/ale-8-m0-tile-grid-entity-store:
- grid/: 8-way neighbours, Chebyshev distance in tiles (1 tile = 5 ft), line of sight over
  walkable/elevation cells, path(a, b, maxCost) with 8-way movement.
- store/: entity store over Snapshot: add/remove/get components, world record (flags, quests,
  clock, maps), toJSON/fromJSON round-trip, structuredClone on read so no live references leak.
- hash/: canonical Blake2 state hash using crypto.createHash('blake2b512') over a stable
  serialisation (sorted keys, HASH_EXCLUDED_COMPONENTS stripped). Stable across serialisation.
- A fixture map (12x12 or so, some unwalkable tiles, a few elevation steps) and a fixture snapshot
  with a player and two dummies, exported for other packages' tests.
- createEngine(initial, {seed}) returning the Engine interface from engine.ts. For ALE-8 it may
  only support 'move' with basic legality (walkable, in range of Stats.speed, alive); ALE-9
  replaces the validation.
- Done when: the store round-trips to JSON, the hash is stable across serialisation and unchanged
  by cosmetic edits, unit tests cover component add/remove.

ALE-9, branch alexfraze/ale-9-m0-rules-engine-core-srd-51-trimmed (branch from main after ALE-8
merges, or stack on the ALE-8 branch if it has not merged yet and say so in the PR):
- rules/: six abilities and modifiers, AC, HP, one move + one action + one bonus action per turn,
  attack rolls with advantage/disadvantage, damage, death at 0 HP, initiative order and a full
  round. All randomness through the seeded Rng in rules/rng.ts.
- Engine.apply validates every intent for legality (action economy, range, line of sight, alive,
  whose turn) BEFORE mutating anything; a rejected intent returns {ok:false, reason} with a
  player-readable reason and changes nothing.
- Done when: property tests (fast-check, seeded) assert that no illegal intent ever changes the
  state hash, and that a full round of initiative resolves deterministically from a seed.

Run pnpm check before each push. Open each PR with the title "ALE-n: ..." and enable auto-merge
if the repo allows it. If Linear tools are available, move each issue to In Progress then In
Review. Do not add dependencies.
```

### Agent B — ALE-10 then ALE-30 (diffs and recorder)

```
You are implementing two Linear issues in alexfraze/deliberate, in order, one PR each:
ALE-10 "M0: Typed diff events" and then ALE-30 "M0: Session recorder". Read CLAUDE.md,
docs/blueprint.md, and both Linear issues first. Work only inside
packages/engine/src/{diffs,recorder} plus packages/engine/src/index.ts exports. Import every
shape from @deliberate/protocol. Another agent is building the store and rules in
engine/src/{grid,store,hash,rules} in parallel; do NOT implement those. Code against the
Snapshot type and the Engine interface (packages/engine/src/engine.ts) and test with fakes.

ALE-10, branch alexfraze/ale-10-m0-typed-diff-events:
- diffs/apply.ts: apply(snapshot, diffs) -> snapshot, pure, for all six Diff types
  (EntityMoved, DamageApplied, ConditionSet, DialogueLine, FlagSet, EntitySpawned). DialogueLine
  is a no-op on state. Never mutate the input.
- diffs/emit.ts: helpers that build each Diff from before/after values so the rules code (other
  agent) can call them.
- Done when: property tests (fast-check, seeded) show apply(snapshot, diffs) == state for random
  diff sequences over a small generated snapshot, comparing by deep equality; hash equality can
  be added once ALE-8 lands.

ALE-30, branch alexfraze/ale-30-m0-session-recorder:
- recorder/recorder.ts: Recorder that writes a RecordingHeader then one RecordedTurn per turn
  (JSONL), taking an Engine and producing lines; the file I/O lives behind a small sink interface
  so the engine package stays I/O free in tests (a Node fs sink is fine as a separate module).
- recorder/replay.ts: replay(lines, createEngine) re-applies each recorded intent through a fresh
  Engine built from the header snapshot and seed, and asserts hashAfter matches each line;
  returns a report of the first divergence.
- recorder/cli.ts: `tsx src/recorder/cli.ts replay <file.jsonl>` exiting non-zero on divergence.
- Done when: a recorded session (use a fake Engine in tests; the real one once ALE-8 merges)
  replays to identical state hashes.

Run pnpm check before each push. Open each PR with the title "ALE-n: ..." and enable auto-merge
if the repo allows it. If Linear tools are available, move each issue to In Progress then In
Review. Do not add dependencies.
```

### Agent C — ALE-11 (WebSocket turn protocol)

```
You are implementing Linear issue ALE-11 "M0: WebSocket turn protocol" in alexfraze/deliberate.
Read CLAUDE.md, docs/blueprint.md, docs/protocol.md, packages/protocol/src/index.ts, and the
Linear issue first. Work only inside packages/server and docs/protocol.md. Branch
alexfraze/ale-11-m0-websocket-turn-protocol.

Build on the existing Fastify skeleton in packages/server/src/app.ts:
- A single in-memory Room holding an Engine (interface in packages/engine/src/engine.ts), the
  current turn number, and the connected sockets. Inject the Engine into buildApp so tests use a
  fake; the real createEngine is wired by the acceptance issue once ALE-8 lands.
- Message handling per docs/protocol.md: join -> snapshot; intent -> engine.apply -> diffs (with
  the new hash and turn+1) or error (reason from the verdict, turn unchanged). Reject stale turns
  and malformed frames with error. Validate frames with type guards, never trust the wire.
- Hook for the recorder: the room emits an event per committed turn that ALE-30's Recorder can
  subscribe to; do not implement the recorder.
- Update docs/protocol.md so it documents exactly what you shipped.
- Done when: a scripted client (a vitest using the ws package, see app.test.ts) connects, sends a
  move intent, and receives the diff stream; an illegal move receives an error with a reason.

Run pnpm check before each push. Open the PR titled "ALE-11: ..." and enable auto-merge if the
repo allows it. If Linear tools are available, move the issue to In Progress then In Review. Do
not add dependencies; do not edit packages/engine or packages/client.
```

### Agent D — ALE-12 (three.js client skeleton)

```
You are implementing Linear issue ALE-12 "M0: three.js client skeleton" in alexfraze/deliberate.
Read CLAUDE.md, docs/blueprint.md, packages/protocol/src/index.ts, and the Linear issue first.
Work only inside packages/client. Branch alexfraze/ale-12-m0-threejs-client-skeleton.

Build on packages/client/src/main.ts and messages.ts:
- Renderer: three.js WebGPURenderer (import from 'three/webgpu') with WebGL fallback when
  navigator.gpu is absent. Isometric orthographic camera with sensible bounds.
- Grid: render MapRecord cells (walkable vs not, elevation as height) from a Snapshot. Placeholder
  meshes for entities (a capsule per entity, colour by faction).
- Input: tile hover highlight, tile select, entity select; selecting an entity then a tile sends
  a move intent; selecting an entity then another entity sends an attack intent. Show the last
  server error reason in the HUD.
- Diff-driven animation queue: consume DiffsMessage in order, tween EntityMoved along its path and
  flash DamageApplied with a floating number, one diff finishing before the next starts. The
  client keeps a render-only copy derived from snapshot + diffs; it is not authoritative.
- Dev fixtures: a static fixture snapshot and a scripted diff stream under src/fixtures so the
  renderer works without the server (start with ?fixture=1). The server protocol may still be in
  progress on another branch.
- Unit tests for the pure parts (grid math to world coordinates, the animation queue ordering).
  Keep three.js out of vitest; a Playwright smoke test that loads the page under Chromium and
  checks a canvas rendered is welcome (Chromium is preinstalled; do not run playwright install).
- Done when: the client renders the M0 map from a server snapshot and animates EntityMoved and
  DamageApplied diffs as they arrive.

Run pnpm check before each push. Open the PR titled "ALE-12: ..." and enable auto-merge if the
repo allows it. If Linear tools are available, move the issue to In Progress then In Review.
Adding @playwright/test as a devDependency of packages/client is the one allowed dependency; say
so in the PR. Do not edit packages/engine or packages/server.
```

### Agent E — ALE-13 (acceptance, after A–D merge)

```
You are implementing Linear issue ALE-13 "M0 acceptance: play by UI alone" in
alexfraze/deliberate. Read CLAUDE.md, docs/blueprint.md, docs/m0-swarm.md, and the Linear issue.
Start from main only after the PRs for ALE-8, ALE-9, ALE-10, ALE-30, ALE-11 and ALE-12 have
merged; if any is still open, wait for it (poll main every 10 minutes) rather than reimplementing.
Branch alexfraze/ale-13-m0-acceptance-play-by-ui-alone.

- Wire the real createEngine (ALE-8/9) into the server room (ALE-11) and the Recorder (ALE-30)
  into the room's turn event, writing recordings/<timestamp>.jsonl.
- Add an e2e/ Playwright test that starts the server and the client, joins, moves the player,
  attacks a dummy, attempts an illegal move and asserts the reason appears in the HUD, then
  replays the written recording with the recorder CLI and asserts identical hashes.
- Add a `pnpm e2e` script and a CI job for it.
- Fix integration bugs you find in any package, minimally, and list them in the PR.
- Done when: you can move and attack through the UI with no model in the loop, the engine rejects
  illegal moves with a visible reason, and the session records to JSONL and replays.

Run pnpm check and pnpm e2e before pushing. Open the PR titled "ALE-13: ...". If Linear tools are
available, move ALE-13 to In Review and note which M0 issues can be closed.
```
