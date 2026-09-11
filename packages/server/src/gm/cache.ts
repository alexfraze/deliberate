import { canonicalize } from '@deliberate/engine';
import type { Diff, EntityId, GmToolCall, Intent, StateHash } from '@deliberate/protocol';

/**
 * The preview and NPC-decision cache (ALE-22) — the `(state, action)` memoisation the blueprint
 * borrows from the ARC no-op guard.
 *
 * **The state hash is the key, and that is the whole invalidation story.** The hash is a Blake2
 * digest over the canonical store with cosmetic fields excluded, so two worlds share a key exactly
 * when they are the same world for rules purposes. A changed world is a changed key, and the old
 * entry is simply never asked for again — there is no invalidation pass to forget to run and no
 * window in which a stale answer can be served. Entries from dead hashes age out of the LRU.
 *
 * **What is cached is a plan, never an outcome.** A preview runs on a clone, and `createEngine`
 * reseeds, so a previewed roll was already a telegraph rather than a promise; replaying a cached
 * telegraph is no more authoritative than the fresh one it copies. Every tool call in a cached
 * entry is re-validated against the real engine before anything commits — by `go` for a preview,
 * and by `/gm/tool` for a cached NPC decision — so the cache cannot become a second source of
 * truth. It can only save the model the trouble of deciding the same thing twice.
 *
 * Two things are deliberately **not** cached: a preview the game master failed to answer (a
 * timeout must not become permanent) and an intent the engine refused (the refusal costs no model
 * call, so there is nothing to save).
 */

/** What a cached preview replays: the prose, the diffs shown, and the calls GO re-validates. */
export interface CachedPreview {
  text: string;
  diffs: Diff[];
  calls: GmToolCall[];
}

/** What a cached NPC turn replays: the mutations the game master asked for, in order. */
export type CachedDecision = GmToolCall[];

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

export interface TurnCache<T> {
  /** The value for `key`, marked most recently used, or `undefined`. Counts a hit or a miss. */
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(): void;
  stats(): CacheStats;
}

/** Entries kept before the least recently used is dropped. A turn's worth of speculation fits. */
export const DEFAULT_CACHE_SIZE = 64;

/**
 * A least-recently-used cache. `Map` iterates in insertion order, so re-inserting on read makes
 * the first key the least recently used one — which is the whole implementation.
 *
 * Values are structured-cloned on the way out. Callers hold the result for the length of a turn
 * and the cache holds it for the length of a session; sharing the array between them would let a
 * later turn's bookkeeping edit an entry an earlier turn thought it owned.
 */
export function createTurnCache<T>(max: number = DEFAULT_CACHE_SIZE): TurnCache<T> {
  const entries = new Map<string, T>();
  let hits = 0;
  let misses = 0;

  return {
    get(key) {
      const value = entries.get(key);
      if (value === undefined) {
        misses += 1;
        return undefined;
      }
      hits += 1;
      entries.delete(key);
      entries.set(key, value);
      return structuredClone(value);
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > Math.max(1, max)) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    clear() {
      entries.clear();
    },
    stats: () => ({ hits, misses, size: entries.size }),
  };
}

/**
 * The key for one preview: the world, the action, and the words the player typed.
 *
 * Free text is part of the key because it is part of the question. "I hail the gate" and "I spit
 * at the gate" are the same `say` intent to the engine and two different turns to the game master,
 * and a cache that conflated them would answer the second with the first's narration.
 */
export function previewKey(hash: StateHash, intent: Intent | null, text: string | null): string {
  return `${hash}|${intent ? canonicalize(intent) : 'none'}|${canonicalize(text)}`;
}

/** The key for one NPC's turn: the world, and whose turn it is. */
export function decisionKey(hash: StateHash, acting: EntityId): string {
  return `${hash}|npc|${acting}`;
}
