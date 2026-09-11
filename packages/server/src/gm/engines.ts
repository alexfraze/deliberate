import {
  createEngine as realCreateEngine,
  type CreateEngine,
  type Engine,
} from '@deliberate/engine';
import type { Entity, Seed } from '@deliberate/protocol';

/**
 * The engine registry (ALE-32, decision 5 of docs/m1-swarm.md).
 *
 * There is exactly one real engine, and there are zero or more **clones**. A clone is a second
 * engine built from the real one's snapshot and the room's seed: a separate store, a separate
 * seeded RNG, no reference back. That is the whole mechanism behind "preview must not mutate" —
 * the GM's tool calls during a preview reach a clone, so there is no code path by which they
 * could reach the real store. Isolation is structural rather than a rule anyone has to remember.
 *
 * An `engine_token` names which engine a `/gm/tool` call acts on. Node mints them, Python echoes
 * them (docs/gm-service.md), and an unknown token is refused rather than falling back to the live
 * engine — falling back is precisely the bug this whole file exists to make impossible.
 *
 * What a clone does *not* carry is the RNG stream position: `createEngine` reseeds from `seed`, so
 * a previewed attack roll is not the roll GO will make. Preview is a telegraph, not a promise, and
 * GO re-validates and re-rolls against the real engine. The alternative — handing the clone the
 * live RNG — would make preview consume the stream and diverge every replay.
 */

/** The token naming the one real engine. Mutations through it commit, broadcast and record. */
export const LIVE_ENGINE_TOKEN = 'live';

export interface EngineHandle {
  readonly token: string;
  readonly engine: Engine;
  /** True only for the real engine. Clones are speculative and are thrown away after a preview. */
  readonly live: boolean;
}

export interface EngineRegistry {
  /** The real engine. */
  readonly live: EngineHandle;
  /** The handle a token names, or `undefined`. Never falls back to the live engine. */
  get(token: string | null | undefined): EngineHandle | undefined;
  /** A fresh speculative engine seeded from the live engine's current snapshot. */
  clone(): EngineHandle;
  /** Discards a clone. Releasing the live token, or an unknown one, does nothing. */
  release(token: string): void;
  /** Live clones outstanding. Tests assert this returns to zero. */
  clones(): number;
}

export interface EngineRegistryOptions {
  engine: Engine;
  /** Seed a clone is rebuilt with. Must be the seed the live engine was built with. */
  seed: Seed;
  /** Templates the `spawn` intent may instantiate; clones need the same ones. */
  templates?: Readonly<Record<string, Entity>>;
  /** Injected so tests can clone with a fake engine. Defaults to the real `createEngine`. */
  createEngine?: CreateEngine;
  /**
   * How many clones may be outstanding before the oldest is discarded. A preview releases its
   * clone in a `finally`, so this only matters when a preview died mid-flight; the cap keeps a
   * crashed GM from leaking snapshots for the life of the process.
   */
  maxClones?: number;
}

const DEFAULT_MAX_CLONES = 8;

export function createEngineRegistry(options: EngineRegistryOptions): EngineRegistry {
  const create = options.createEngine ?? realCreateEngine;
  const maxClones = options.maxClones ?? DEFAULT_MAX_CLONES;
  const live: EngineHandle = { token: LIVE_ENGINE_TOKEN, engine: options.engine, live: true };
  // Insertion-ordered, so the first key is the oldest clone.
  const speculative = new Map<string, EngineHandle>();
  let minted = 0;

  return {
    live,
    get(token) {
      if (token === undefined || token === null || token === LIVE_ENGINE_TOKEN) return live;
      return speculative.get(token);
    },
    clone() {
      minted += 1;
      const token = `preview-${minted}`;
      const engine = create(options.engine.snapshot(), {
        seed: options.seed,
        ...(options.templates ? { templates: options.templates } : {}),
      });
      const handle: EngineHandle = { token, engine, live: false };
      speculative.set(token, handle);
      while (speculative.size > maxClones) {
        const oldest = speculative.keys().next().value;
        if (oldest === undefined) break;
        speculative.delete(oldest);
      }
      return handle;
    },
    release(token) {
      speculative.delete(token);
    },
    clones: () => speculative.size,
  };
}
