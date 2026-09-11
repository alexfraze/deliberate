import { join } from 'node:path';

import { createSave } from '@deliberate/engine';
import { readSave, writeSave } from '@deliberate/engine/fs';
import type { RoomId, SaveFile, Seed } from '@deliberate/protocol';

import type { GmLoop } from './gm/loop.js';
import type { Room } from './room.js';

/**
 * Save and load (ALE-23), wired to a room. One JSON file per room, overwritten: a save slot, not
 * a history — the JSONL recording is the history, and a database is roadmap P2 (ALE-26).
 *
 * The interesting part is what goes in beyond the store. `createSave` takes the engine's RNG
 * stream position so a resumed session keeps rolling the same sequence, and this module supplies
 * the two things the engine cannot know: which turn the room is on, and the memory blocks the GM
 * service handed back last (ALE-15) — the verified ledger and the world model, without which a
 * loaded session has its world but not its history.
 *
 * Like `recording.ts`, this and `@deliberate/engine/fs` are the only places in the server that
 * touch the filesystem.
 */

export { readSave } from '@deliberate/engine/fs';

export interface SaveSlot {
  /** The file `write()` replaces. */
  readonly path: string;
  /** Captures the room, the engine's RNG position and the GM's memory, and writes them. */
  write(): SaveFile;
}

export interface SaveSlotOptions {
  /** Directory the file lives in; created on the first write. */
  dir: string;
  /** The seed the room's engine was built with. A save is only resumable with the right one. */
  seed: Seed;
  /** Scene the world was booted from, so a load restores the GM's `spawn` templates. */
  scene?: string | null;
  /** The wall clock. Injected because the engine has none, and so tests can pin the file. */
  now?: () => Date;
}

/** `saves/<room>.json`. Predictable, so `DELIBERATE_LOAD` can name it without hunting. */
export function saveFileName(room: RoomId): string {
  return `${room}.json`;
}

export function saveSlot(room: Room, gm: GmLoop, options: SaveSlotOptions): SaveSlot {
  const path = join(options.dir, saveFileName(room.id));
  return {
    path,
    write() {
      const save = createSave(room.engine, {
        room: room.id,
        turn: room.turn(),
        seed: options.seed,
        scene: options.scene ?? null,
        memory: gm.memory(),
        savedAt: (options.now ?? (() => new Date()))().toISOString(),
      });
      writeSave(path, save);
      return save;
    },
  };
}

/** Reads a save, or `null` when `path` is null. Throws `SaveError` on a file this build refuses. */
export function loadSave(path: string | null): SaveFile | null {
  return path ? readSave(path) : null;
}
