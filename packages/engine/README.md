# @deliberate/engine

The only code that mutates world state. Pure TypeScript, deterministic, no I/O.

| Directory       | Linear | Owns                                                                         |
| --------------- | ------ | ---------------------------------------------------------------------------- |
| `src/grid/`     | ALE-8  | Tile math: 8-way neighbours, Chebyshev distance, line of sight, `path()`     |
| `src/store/`    | ALE-8  | Entity store (component add/remove), world record, JSON round-trip           |
| `src/hash/`     | ALE-8  | Canonical Blake2 state hash (`crypto.createHash('blake2b512')`, no dep)      |
| `src/rules/`    | ALE-9  | SRD 5.1 trimmed: abilities, AC, HP, action economy, attack rolls, initiative |
| `src/diffs/`    | ALE-10 | Diff emission; `apply(snapshot, diffs)` reproduces state                     |
| `src/recorder/` | ALE-30 | JSONL recorder and `replay()` asserting hashes                               |

Rules of the package:

- Import shapes from `@deliberate/protocol`; do not redefine them here.
- Never call `Math.random` (lint-enforced). Take an `Rng` from `src/rules/rng.ts`.
- Never `Date.now()` inside rules; the world clock is a number in the snapshot.
- Tests live next to code as `*.test.ts`. Property-style tests over random action sequences are
  expected for ALE-9 and ALE-10; use a seeded `Rng` to generate the sequences so failures reproduce.
