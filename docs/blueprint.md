# Deliberate Blueprint

Text reference for agents working the issues. Mirrors the Linear document
[Deliberate Blueprint](https://linear.app/alex13-personal/document/deliberate-blueprint-5126db4e6464);
the Linear copy wins if they drift.

## Vision

A turn-based tactical RPG in the Baldur's Gate lineage where an agentic, vision-capable LLM runs the
world between your decision and the moment you press GO. The engine owns the rules; the model owns
the story, the NPCs, and the consequences.

## Pillars

1. **Engine authority.** World state lives in a typed store. The model only mutates it through
   validated tools.
2. **Grid-native simulation.** Square tile grid the model reasons about in code; the renderer draws
   3D on top. LLMs are strong in discrete worlds and weak at pixel precision.
3. **Latency as a feature.** Preview-then-GO turns model time into telegraphed intent. Speculative
   previews and cached NPC brains keep the wait short.
4. **Replay everything.** Every turn is recorded as state, intent, tool calls, verdicts, and diffs.
   Prompt and model changes are judged on replayed sessions.

## Turn loop

| Phase      | Owner               | What happens                                                                                 | MVP budget |
| ---------- | ------------------- | -------------------------------------------------------------------------------------------- | ---------- |
| Deliberate | Player              | Pick an intent: move, ability, dialogue, or free text. Nothing committed.                    | unbounded  |
| Preview    | GM                  | Proposes the likely resolution and telegraphs NPC reactions. Cached by (state hash, intent). | ≤ 8 s      |
| GO         | Player              | Commit. Engine validates every proposed call and applies the diff.                           | < 100 ms   |
| Resolve    | Engine + NPC brains | Initiative runs. NPCs act through policies; GM consulted only when asked.                    | ≤ 6 s      |
| Narrate    | GM                  | Streamed prose and dialogue for what the engine did; optional async cinematics.              | 1–3 s      |

Targets: after-GO p50 10 s (MVP) → 3 s (final); GM input ≤ 12k tokens/turn → ≤ 8k with ledger
compaction; cost $0.03–0.10/turn → < $0.005 on local serving.

## Architecture

| Layer                    | Owns                                                                               | Never does                                            |
| ------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Client (browser)         | Rendering, camera, input, preview UI, narration stream                             | Hold authoritative state; call the model              |
| Game server              | Entity store, rules engine, initiative, turn orchestration, recording, persistence | Free-text mutation of state                           |
| LLM service              | GM agent loop, tool contract, memory blocks, NPC brain generation, sandboxed code  | Touch the renderer; treat player text as instructions |
| Asset pipeline (offline) | Blender scripts, image generation, glTF export, tile masks                         | Run during a turn                                     |

The renderer boundary is strictly "state diff in, frames out" so a neural renderer can later sit
behind it for cinematics.

## Game master contract

Query tools (free): `get_state(scope)`, `legal_actions(entity_id)`, `line_of_sight(a, b)`,
`path(a, b, max_cost)`, `recall(topic)`, `roll_preview(action)`.

Mutation tools (validated): `move(entity_id, to)`, `attack(attacker, target, ability)`,
`cast(entity_id, spell, target)`, `say(npc_id, text, to)`, `set_disposition(npc_id, delta, reason)`,
`spawn(template_id, at)`, `set_flag(key, value)`, `advance_quest(quest_id, step)`,
`end_turn(entity_id)`.

Each mutation returns `{ok, reason, diff}`. Batches stop at the first rejection.

Memory blocks re-injected every turn: world model, active threads, NPC goals and dispositions,
**verified ledger** (engine-generated intent → outcome lines; survives compaction), player profile.

Rules baseline: CC-BY SRD 5.1 trimmed (six abilities, AC, HP, move + action + bonus action,
advantage/disadvantage, initiative).

## Data model

- **Space:** square grid, 8-way, one tile = 5 ft, integer elevation. Hex deferred.
- **Entities:** `Position`, `Stats`, `Health`, `Inventory`, `Faction`, `Disposition`, `Brain`,
  `Dialogue`, `Portrait`.
- **World:** flags, quests with steps, clock, loaded maps.
- **Diffs:** `EntityMoved`, `DamageApplied`, `ConditionSet`, `DialogueLine`, `FlagSet`,
  `EntitySpawned`, `TurnAdvanced`, `EconomySpent`, `FacingChanged`. The last three were added in
  M0 (ALE-13): combat mutates turn order, the turn economy, the world clock and an attacker's
  facing, and without them `apply(snapshot, diffs)` did not reproduce the engine's state.
- **State hash:** Blake2 over the canonical store excluding cosmetic fields; keys the preview and
  NPC-brain caches.
- **Recording:** one JSONL line per turn (state hash, intent, tool calls + verdicts, diffs, tokens,
  latency), replayable with the engine alone.
- **Save:** one JSON document (ALE-23) — the store, the world record, the room's turn counter, the
  seed, the RNG stream position and the GM's memory blocks. The stream position is what a snapshot
  cannot give you: without it a resumed session restores the same hash and then rolls dice the
  uninterrupted one had already spent. Versioned, so a format change is detected rather than
  misread. A database is roadmap P2 (ALE-26).

These shapes are code in `packages/protocol/src/index.ts`.

## Tech stack

- **Client:** TypeScript, three.js (WebGPU renderer, WebGL fallback), glTF, post-processing. Godot
  is the fallback for a native client.
- **Game server:** Node 22 + TypeScript, Fastify, WebSocket rooms, in-memory entity store;
  Postgres + Redis after the MVP.
- **LLM service:** Python 3.12, FastAPI. MVP on the Claude API with tool use. Final: local vLLM
  serving Qwen3.8-Flash-Next NVFP4 with MTP (the Kaggle-proven profile).
- **Sandbox:** the ARC-AGI-3 Python sandbox (RPC with refreshed globals, hard timeouts, restricted
  builtins).
- **NPC brains (ALE-37):** model-written Python policies per NPC, cached by situation, run in the
  sandbox each turn. They propose tool calls through the same validated door; the engine still
  decides. See `docs/gm-service.md`, "NPC code brains".
- **Assets:** Blender 4.x headless `bpy`, glTF export, Flux/SD for textures and portraits, stylized
  low-poly art direction.
- **Cinematics (optional):** Hunyuan-GameCraft or an image model, async, cached, behind the
  renderer boundary.
- **Observability and testing:** OpenTelemetry per turn, session recorder, vitest + pytest,
  replay-based regression, injection test bank.

## What transfers from ARC-AGI-3

The ARC-AGI-3 code lives at `~/Documents/arc-agi-3` on Alex's machine and is not on GitHub, so
cloud agents cannot read it. It is only needed from M1 (ALE-14) onward.

| Asset                                                   | Role here                                              |
| ------------------------------------------------------- | ------------------------------------------------------ |
| `inference/agent/python_tool_sandbox.py`                | GM and NPC code execution with the `action()` RPC      |
| `inference/agent/tool_agent.py`                         | GM loop: tool parsing, history trimming, notes, ledger |
| `inference/utils/segmentation.py`                       | Walkable/blocked tile masks from generated backdrops   |
| `eval/` scorecard + `duck_validation.json`              | Replay harness and per-session scoring                 |
| `kaggle/vllm_launch.py` + Flash-Next `serving_setup.py` | Local serving at scale                                 |
| No-op guard / state-graph memoization                   | Preview cache and NPC-brain cache                      |
| `duck/session.py` no-impact batch stop                  | Reject-and-stop discipline for tool batches            |
| `duck/h1_observability.py`                              | Per-turn telemetry shape                               |

## MVP

Single player, one hand-built map, three NPC archetypes, combat and dialogue, preview-then-GO,
replay. End-to-end at every milestone after M0.

- **M0 Skeleton without a model** (week 1): grid, entity store, rules engine, diffs, WebSocket
  protocol, three.js skeleton, recorder. Done when you can move and attack by UI alone and the
  session replays.
- **M1 The game master arrives** (week 2): LLM service, tool contract, memory blocks,
  preview-then-GO, three archetypes, player text quoted as data. Done when a ten-turn playthrough
  runs end-to-end with every mutation carrying a verdict.
- **M2 It looks like a game** (week 3): Blender asset generator, lighting/camera/post, animations,
  portraits + dialogue panel. Done when a stranger calls it a game.
- **M3 Hardened and measured** (week 4): replay regression, injection bank, preview cache,
  save/load, cost and latency meters. Done when three playthroughs replay deterministically, the
  injection bank passes, and p50 after GO < 10 s.

Out of the MVP on purpose: multiplayer, database persistence, NPC code brains, local serving,
cinematics, content tooling, a second map.

## Roadmap

P1 NPC code brains + skill cache · P2 multiplayer rooms + persistence · P3 local serving on
Flash-Next · P4 art pipeline at scale + cinematics · P5 content tooling · P6 eval-driven tuning.

## Risks

Latency (speculative preview, cached brains, MTP, streamed narration) · drift (engine authority,
verified ledger, reference checks) · cost (token budgets, compaction, local serving) · prompt
injection (quoted input, engine validation, sandbox, injection bank) · art quality (stylized
direction, lighting, scripted assets) · scope creep (closed MVP list).

## Decisions

Decided: engine authority; square grid; three.js client; Claude API for MVP, local Flash-Next for
scale; SRD 5.1 baseline; world models as cinematics only; replay is the test suite.

Decided for M0 by the scaffold: Node 22 + pnpm (not Bun); vitest; ESM; strict TypeScript.

Open: final name; hex vs square after M1; per-NPC vs per-archetype brains; art direction reference
sheet before M2.

## Swarm split

One agent per **Area** label (server, client, llm, art, eval, safety, content, observability,
infra). The `acceptance` issue in each milestone is the integration gate; M0 is the only milestone
where all areas run fully in parallel because nothing depends on the model yet. The concrete M0
launch plan is in [m0-swarm.md](m0-swarm.md).
