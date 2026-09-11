/**
 * @deliberate/engine — the only code path that mutates world state.
 *
 * Pure TypeScript: no I/O, no network, no timers, no Math.random. Every mutation is validated
 * before it applies and emits typed diffs (see @deliberate/protocol). Determinism is a hard
 * requirement because recorded sessions must replay to identical state hashes.
 *
 * Layout and Linear ownership (see packages/engine/README.md):
 *   src/grid/      ALE-8   tiles, 8-way neighbours, distance, line of sight, pathing
 *   src/store/     ALE-8   entity store, world record, JSON round-trip
 *   src/hash/      ALE-8   canonical Blake2 state hash
 *   src/rules/     ALE-9   SRD 5.1 trimmed rules, action economy, initiative, seeded RNG
 *   src/diffs/     ALE-10  diff emission and apply(snapshot, diffs)
 *   src/recorder/  ALE-30  JSONL recorder and replay
 */

export type { CreateEngine, Engine, EngineOptions } from './engine.js';
export * from './grid/index.js';
export * from './hash/index.js';
export * from './rules/index.js';
export * from './store/index.js';

export const ENGINE_VERSION = '0.0.0' as const;
