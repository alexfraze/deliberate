import { canonicalize } from '@deliberate/engine';
import type { Diff, EntityId, GmToolCall, Intent, Snapshot, StateHash } from '@deliberate/protocol';

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
  /** Forgets one entry. The skill cache uses it to retire a policy that stopped working. */
  delete(key: string): void;
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
    delete(key) {
      entries.delete(key);
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

// -----------------------------------------------------------------------------------------------
// The skill cache (ALE-37)
// -----------------------------------------------------------------------------------------------

/**
 * A policy the game master wrote for one NPC: a Python program the server runs in the GM service's
 * sandbox to take that NPC's turn, instead of asking the model what it does.
 *
 * Source, not behaviour, and not state. Nothing happens because a policy exists; something happens
 * when it runs and the engine accepts one of the calls it proposes — through the same `/gm/tool`
 * door, with the same validation and the same freshly rolled dice.
 */
export interface CachedPolicy {
  code: string;
  /** The game master's one line about what it does. Logs and traces only. */
  note: string;
  /** The turn it was written on, so a log can say how long a policy has been serving. */
  turn: number;
}

/**
 * The disposition bands `content/npcs` already gates its dialogue on (`maxDisposition: -20`,
 * `minDisposition: 25`). Reusing the content's own thresholds rather than inventing new ones keeps
 * "the situation changed" meaning the same thing to the policy cache as it does to the writing.
 */
export type Stance = 'hostile' | 'wary' | 'warm';

export function stanceOf(disposition: number): Stance {
  if (disposition < -20) return 'hostile';
  if (disposition < 25) return 'wary';
  return 'warm';
}

/**
 * The key for one NPC's policy — and the answer to "regenerate only when the situation changes".
 *
 * The state hash cannot be the key here. It is the right key for a *decision*, which is an answer
 * to one exact world, but a policy is a strategy for a *kind* of world: keyed on the hash it would
 * be written once and never read again, because the world moves every turn. So the key is the
 * coarsest description of the situation that still makes a different policy necessary:
 *
 * - **who is acting.** Per-NPC, not per-archetype. The archetype is not in the snapshot — it is a
 *   template id the engine keeps for `spawn` — so keying on it would mean either putting it into
 *   the entity (which changes the state hash and reddens every recording in the bank) or keeping a
 *   second entity-to-archetype table in the server, a copy of a fact the engine owns. And a policy
 *   is a plan for a *person*: `content/npcs` gives each NPC its own goals, and the guard's "do not
 *   strike the player first" is not the merchant's strategy.
 * - **whether initiative is running.** Fighting and not fighting are different problems.
 * - **which factions are still standing.** Target selection is about who is in the room. The last
 *   member of a faction dying is the clearest "the situation changed" there is.
 * - **how this NPC feels about the player**, in the three bands above. A guard whose disposition
 *   flipped mid-scene wants a different program, not the same one applied harder.
 *
 * Everything finer than that — positions, hit points, whose turn is next, how much of the action
 * economy is left — is deliberately *not* in the key, because the policy reads all of it out of
 * `state` on the turn it runs. That is the whole difference between a cached decision and a cached
 * skill: the decision is frozen, the skill re-decides from live state every time.
 *
 * A key that is too coarse cannot produce a wrong-but-accepted turn, because a policy accepts
 * nothing: every call it proposes is validated by the engine, and a stale one is refused with a
 * reason like any other. What it can produce is a turn where the NPC lands nothing — and the loop
 * treats that as the policy having expired, retires it, and asks the model instead.
 */
export function policyKey(snapshot: Snapshot, acting: EntityId): string {
  const factions = new Set<string>();
  let player: EntityId | null = null;
  for (const entity of Object.values(snapshot.entities)) {
    if (entity.components.brain?.policy === 'player') player = entity.id;
    if (entity.components.health?.conditions.includes('dead')) continue;
    factions.add(entity.components.faction?.id ?? 'none');
  }
  const toward = snapshot.entities[acting]?.components.disposition?.toward ?? {};
  return canonicalize({
    acting,
    combat: snapshot.initiative !== null,
    factions: [...factions].sort(),
    stance: stanceOf(player ? (toward[player] ?? 0) : 0),
  });
}
