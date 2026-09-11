import type { Entity, Intent, Seed, Snapshot, StateHash, Verdict } from '@deliberate/protocol';

/**
 * The seam between the engine and everything else. The server (ALE-11) drives a room through
 * this; the recorder's `replay` (ALE-30) re-applies recorded intents through it. ALE-8, ALE-9 and
 * ALE-10 together implement it (`createEngine`). Consumers must code against this interface and
 * test with a fake, never against engine internals, so the packages integrate without rework.
 */
export interface Engine {
  /** A deep, JSON-safe copy of the authoritative state. Never a live reference. */
  snapshot(): Snapshot;
  /** Canonical Blake2 hash of the current state with cosmetic components excluded. */
  hash(): StateHash;
  /** Validates the intent; on `ok` applies it and returns the diffs, otherwise touches nothing. */
  apply(intent: Intent): Verdict;
}

export interface EngineOptions {
  /** Drives every roll. Same seed and same intents replay to the same hashes. */
  seed: Seed;
  /**
   * Entity templates the `spawn` intent may instantiate, keyed by template id (ALE-31). The
   * engine is I/O free, so whoever constructs it hands these in — the server loads them from
   * `content/npcs/`. Omitted means no templates, and every `spawn` is rejected.
   */
  templates?: Readonly<Record<string, Entity>>;
}

/** Signature the engine package exports once ALE-8 lands. Declared here so consumers can type it. */
export type CreateEngine = (initial: Snapshot, options: EngineOptions) => Engine;
