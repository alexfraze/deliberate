import {
  PROTOCOL_VERSION,
  SAVE_VERSION,
  type Entity,
  type RoomId,
  type SaveFile,
  type Seed,
} from '@deliberate/protocol';

import type { Engine } from '../engine.js';
import { createEngine } from '../rules/create-engine.js';
import { assertSnapshot } from '../store/store.js';

/**
 * Save and load (ALE-23): one JSON document per session, no database (that is roadmap P2, ALE-26).
 *
 * The store already round-trips through JSON, so this module is not a second serialiser. What it
 * adds is everything a snapshot on its own does not carry:
 *
 * - **The RNG stream position.** The subtle one. A save that restores the store restores the state
 *   hash and nothing else: `createRng` would start the seed's sequence over, so the first roll
 *   after a load is a roll the uninterrupted session had already spent. Every roll from then on
 *   differs, and a resumed session no longer replays. `rngCalls` is the fix, and
 *   `save.test.ts` proves it by comparing a save/load run against an uninterrupted one roll for
 *   roll — not merely by comparing hashes at the moment of loading, which passes either way.
 * - **The GM's memory blocks.** The GM service is stateless and Node persists what it hands back
 *   (ALE-15), so without them a loaded session keeps its world and forgets its history: the
 *   verified ledger and the world model are as much a part of "the GM continues coherently" as
 *   the entity store is.
 * - **A version.** `SAVE_VERSION` is checked on load, so a future format change is detected
 *   instead of silently misread.
 *
 * Cosmetic components (`dialogue`, `portrait`) are outside the state hash but inside the save:
 * a load has to look right as well as hash right.
 *
 * There is no I/O and no clock here. The engine stays pure; `@deliberate/engine/fs` reads and
 * writes the file, and the caller supplies `savedAt`.
 */

export class SaveError extends Error {
  override readonly name = 'SaveError';
}

/** What the engine cannot tell you about itself: who was playing, and what the GM remembers. */
export interface SaveMeta {
  room: RoomId;
  /** The turn the room is accepting intents for. */
  turn: number;
  /** The seed the engine was built with. A save is only resumable if this is the right one. */
  seed: Seed;
  /** Scene the world was booted from, so `spawn` templates come back. */
  scene?: string | null;
  /** The GM's memory blocks, as the service last handed them back. */
  memory?: Record<string, unknown>;
  /**
   * When the save was taken, ISO-8601. Required rather than defaulted: the engine has no clock —
   * `Date.now()` is as forbidden here as `Math.random` — so whoever has one passes it in, the way
   * the recorder takes `startedAt`.
   */
  savedAt: string;
}

/** Everything needed to resume this engine, as a plain JSON-safe object. */
export function createSave(engine: Engine, meta: SaveMeta): SaveFile {
  return {
    save: SAVE_VERSION,
    protocol: PROTOCOL_VERSION,
    savedAt: meta.savedAt,
    room: meta.room,
    turn: meta.turn,
    seed: meta.seed,
    rngCalls: engine.rngCalls(),
    scene: meta.scene ?? null,
    snapshot: engine.snapshot(),
    hash: engine.hash(),
    memory: structuredClone(meta.memory ?? {}),
  };
}

/** Pretty-printed, because a save is a file a person may open and a diff a person may read. */
export function saveToJSON(save: SaveFile): string {
  return `${JSON.stringify(save, null, 2)}\n`;
}

/**
 * Structural check that `value` is a `SaveFile`. The version is checked first and hardest: a file
 * written by a future format must fail here rather than load three quarters of a world.
 */
export function assertSave(value: unknown): asserts value is SaveFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SaveError('a save must be an object');
  }
  const save = value as Record<string, unknown>;
  if (save['save'] !== SAVE_VERSION) {
    throw new SaveError(
      `save version ${String(save['save'])} is not ${SAVE_VERSION}; this file was written by a different version of the game`,
    );
  }
  if (save['protocol'] !== PROTOCOL_VERSION) {
    throw new SaveError(`save protocol ${String(save['protocol'])} != ${PROTOCOL_VERSION}`);
  }
  if (typeof save['seed'] !== 'string') throw new SaveError('save.seed must be a string');
  if (typeof save['room'] !== 'string') throw new SaveError('save.room must be a string');
  if (!Number.isInteger(save['turn']) || (save['turn'] as number) < 0) {
    throw new SaveError('save.turn must be a turn number');
  }
  if (!Number.isInteger(save['rngCalls']) || (save['rngCalls'] as number) < 0) {
    throw new SaveError('save.rngCalls must be a non-negative integer');
  }
  if (typeof save['hash'] !== 'string') throw new SaveError('save.hash must be a string');
  const memory = save['memory'];
  if (typeof memory !== 'object' || memory === null || Array.isArray(memory)) {
    throw new SaveError('save.memory must be an object');
  }
  assertSnapshot(save['snapshot']);
}

/** Parse JSON text into a validated save. */
export function saveFromJSON(text: string): SaveFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new SaveError(`save is not valid JSON: ${(e as Error).message}`);
  }
  assertSave(parsed);
  return parsed;
}

export interface LoadOptions {
  /** Templates the `spawn` intent may instantiate. The caller loads them from the save's scene. */
  templates?: Readonly<Record<string, Entity>>;
}

/**
 * Rebuild the engine the save was taken from: same store, same seed, same place in the roll
 * sequence. Throws when the rebuilt state does not hash to what the file claims, which catches a
 * truncated or hand-edited file at load rather than at the first divergent replay.
 */
export function engineFromSave(save: SaveFile, options: LoadOptions = {}): Engine {
  assertSave(save);
  const engine = createEngine(save.snapshot, {
    seed: save.seed,
    rngCalls: save.rngCalls,
    ...(options.templates ? { templates: options.templates } : {}),
  });
  const hash = engine.hash();
  if (hash !== save.hash) {
    throw new SaveError(`save hashes to ${hash}, but the file says ${save.hash}`);
  }
  return engine;
}
