import { join } from 'node:path';

import { createRecorder, type Recorder } from '@deliberate/engine';
import { fileSink } from '@deliberate/engine/fs';
import type { Seed } from '@deliberate/protocol';

import type { Room } from './room.js';

/**
 * Session recording (ALE-30 wired up by ALE-13). One JSONL file per run of the server: a header
 * naming the starting snapshot, its hash and the seed, then one line per committed turn. That is
 * everything `pnpm replay` needs to re-run the session through a fresh engine and check every
 * hash, which is the M0 exit criterion.
 *
 * This module and `@deliberate/engine/fs` are the only places in the server that touch the
 * filesystem. The room knows nothing about it: recording is `room.onTurn` and nothing more, so
 * turning it off changes no other behaviour.
 */

export interface Recording {
  /** The file being appended to. */
  readonly path: string;
  readonly recorder: Recorder;
  /** Unsubscribes from the room and closes the file. Safe to call more than once. */
  close(): void;
}

export interface RecordingOptions {
  /** Directory the file is created in; created if it does not exist. */
  dir: string;
  /**
   * The seed the room's engine was built with. The recording is only replayable if this matches;
   * `buildApp` passes the seed it used, so an injected engine must be given its seed too.
   */
  seed: Seed;
  /** The wall clock. Injected because the engine has none and so tests can name the file. */
  now?: () => Date;
}

/** `2026-09-11T16-20-30-123Z.jsonl`: sortable, and legal on filesystems that dislike colons. */
export function recordingFileName(at: Date): string {
  return `${at.toISOString().replace(/[:.]/g, '-')}.jsonl`;
}

export function recordSession(room: Room, options: RecordingOptions): Recording {
  const startedAt = (options.now ?? (() => new Date()))();
  const path = join(options.dir, recordingFileName(startedAt));
  const recorder = createRecorder(room.engine, {
    room: room.id,
    seed: options.seed,
    startedAt: startedAt.toISOString(),
    sink: fileSink(path),
  });
  const off = room.onTurn((commit) => {
    // One line per mutation the engine actually saw, the GM's included, in the order it saw them.
    // That is what keeps `pnpm replay` exact once a model is in the loop: replay re-applies
    // intents, and a GM tool call is an intent (ALE-31), so nothing in a turn is unaccounted for.
    recorder.record(commit.intent, commit.verdict, commit.hashBefore, {
      toolCalls: commit.toolCalls,
    });
  });

  let closed = false;
  return {
    path,
    recorder,
    close() {
      if (closed) return;
      closed = true;
      off();
      recorder.close();
    },
  };
}
