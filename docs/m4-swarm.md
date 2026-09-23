# M4 swarm launch plan — the world grows

Goal: milestone **M4 The world grows**. The game master stops being a narrator inside one authored
map and becomes a game master in the older sense: it extends the world as you play, and the engine
refuses anything it cannot check.

M4 exit: a player walks into a location that did not exist when the session started, and the
recording of that session replays hash-for-hash with no key, no network and no Python.

## What already exists, and has never been used

This milestone is mostly _using_ the data model rather than changing it. ALE-8 specified "loaded
maps", plural, on day one:

```ts
World.maps: Record<MapId, MapRecord>          // a registry, not a map
Position.map: MapId                           // every entity already knows its map
store.getMap / hasMap / setMap / removeMap    // full CRUD, already there
get_state → maps: Object.keys(world.maps)     // the GM can already list them
```

Nothing has ever loaded a second map. `move` validates within one map, the client renders exactly
one, and the gatehouse is the only location that exists.

The engine also already owns the primitives that make authored content _checkable_: `path()`,
`isWalkable()` and `lineOfSight()`.

## Decisions made before the swarm starts

### 1. The frontier, not the generator

The world has **undefined edges**. Approaching one — a door to nowhere, a road off the map —
triggers authoring. The GM writes what is beyond it, the engine validates, and only then does it
exist.

Rejected: pre-generating speculatively while the player plays. Authoring is an expensive call and
a speculative one is usually wasted; the frontier is both cheaper and closer to how a game master
actually works at a table.

### 2. Authored content is validated, never trusted

This is the decision that makes the whole milestone safe, and it is the same discipline as every
other GM mutation: propose, validate, verdict. The engine refuses a map that is:

- **malformed** — `cells.length !== width * height`, elevations out of range, duplicate `MapId`,
  or outside the size bounds (a 500×500 map would blow the prompt budget and the state hash);
- **unreachable** — this is the one that matters. Every declared exit and objective must be
  walkable-reachable from the entrance, checked with the engine's own `path()`. A location whose
  objective sits behind a wall is a broken location, and the model does not get to create one;
- **disconnected** — a walkable region with no path from the entrance is dead space;
- **inconsistent** — if map A exits to B at a tile, B must carry the matching entrance;
- **dangling** — entity, template and quest references must resolve.

A refused map comes back with a player-readable reason like any illegal move. **The model cannot
author a broken world into existence.**

### 3. `MapAuthored` is an additive diff — replay stays model-free

The authored map's bytes go into the recording as a diff. Replay applies them; it never calls the
model. This is non-negotiable and it is the thing most likely to be got wrong.

We have already been bitten by the miniature version: `RecordingHeader` did not carry the
`templates` table, so any session containing a `spawn` silently failed to replay (found in
ALE-21). A generated _map_ is the same bug with more surface.

`pnpm bank` — 8 sessions, 316 turns — is the tripwire and must stay green.

### 4. Terrain and population are separate

`author_map` writes **terrain only**. Populating it uses `spawn`, which already exists and is
already template-validated. Keeping them apart means the existing spawn validation is not
bypassed by a new door, and one big tool does not become the place where the rules get soft.

### 5. Transitions come first and need no model

Walking between two _existing_ maps is pure engine work: an additive intent, validated like any
move, plus the client swapping what it renders. It is a prerequisite — authoring is meaningless
until you can walk somewhere — and it is the half a player will exercise constantly.

### 6. Scale is a scoping problem, not a storage problem

The prompt is capped at ≤ 12k input tokens and `stateSummary` is small on purpose. A growing world
cannot all be described every turn. `get_state(scope)` becomes genuinely spatial — the current map
plus adjacency summaries — and `recall(topic)` covers anywhere else.

**Ambient turns need the same locality.** One NPC acts per turn today; across thirty NPCs that is
once every thirty turns and the world feels _emptier_ than it does now. Ambient candidates must be
scoped to the player's map and vicinity.

### 7. The cost shape is a feature — protect it

Authoring is expensive per call but **amortised**: a location is written once and persists, unlike
the per-turn costs this project has been fighting all along. A twenty-location world costs twenty
authoring calls in total, and ALE-23's save/load means authored content survives a restart.

Do not let that shape rot into per-turn cost. Author at the frontier, once, and cache.

## Ownership

| Path                                        | Agent | Notes                                            |
| ------------------------------------------- | ----- | ------------------------------------------------ |
| `packages/protocol` (traverse intent)       | G     | additive                                         |
| `packages/engine/src/rules`                 | G     | transition legality                              |
| `packages/server/src/gm/loop.ts`, `room.ts` | G     | transitions **and** ambient locality             |
| `packages/client`                           | G     | map swap on transition                           |
| `contracts/gm-tools.json`                   | H     | `author_map`                                     |
| `packages/protocol` (`MapAuthored` diff)    | H     | additive                                         |
| `packages/engine/src/gm`                    | H     | the validation rules, `get_state` scope plumbing |
| `services/gm/`                              | I     | authoring prompt, spatial state summary, memory  |

G and H both touch `packages/protocol`, additively and in different regions; whoever lands second
rebases. `services/gm` belongs to I alone.

## Agents

| Agent | Issue                                | Points |
| ----- | ------------------------------------ | ------ |
| G     | Map transitions (no model)           | 3      |
| H     | GM map authoring + engine validation | 8      |
| I     | Spatial scoping + ambient locality   | 5      |
| J     | M4 acceptance, after G/H/I merge     | 1      |

G starts first and alone — H's authoring is untestable end to end until you can walk somewhere.
H and I start alongside G and code against the shapes fixed in this document.
