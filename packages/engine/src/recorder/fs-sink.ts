import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { SaveFile } from '@deliberate/protocol';

import { saveFromJSON, saveToJSON } from '../save/save.js';
import type { BankEntry, BankManifest } from './bank.js';
import type { LineSink } from './sink.js';

/**
 * The one module in `@deliberate/engine` that touches the filesystem. It is deliberately outside
 * the engine's pure core: the recorder writes through the `LineSink` interface and never imports
 * this, so engine tests stay I/O free. The server (ALE-13) wires it to `recordings/<ts>.jsonl`.
 *
 * Save files (ALE-23) live here for the same reason: `src/save/` builds and validates the
 * document, and these two functions are the only part of it that touches a disk.
 */

/** Appends lines to `path`, creating the directory and the file. Keeps the descriptor open. */
export function fileSink(path: string): LineSink {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number | undefined = openSync(path, 'a');
  return {
    write(line) {
      if (fd === undefined) {
        // Closed: fall back to an append so a late line is never silently dropped.
        appendFileSync(path, `${line}\n`);
        return;
      }
      writeSync(fd, `${line}\n`);
    },
    close() {
      if (fd === undefined) return;
      closeSync(fd);
      fd = undefined;
    },
  };
}

/** Read a recording back as its raw JSONL lines. */
export function readLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

/**
 * Read the regression bank (ALE-21): `<dir>/bank.json` names the sessions and the numbers each one
 * produced, and every `file` beside it is a recording. Returns what `runBank` consumes, so the CLI
 * and the test in `packages/server/src/bank/` load the bank exactly the same way.
 */
export const BANK_MANIFEST = 'bank.json';

export function loadBank(dir: string): BankEntry[] {
  const manifest = JSON.parse(readFileSync(join(dir, BANK_MANIFEST), 'utf8')) as BankManifest;
  return manifest.sessions.map((session) => ({
    session,
    lines: readLines(join(dir, session.file)),
  }));
}

/** Write a save (ALE-23) to `path`, creating the directory. Replaces any file already there. */
export function writeSave(path: string, save: SaveFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, saveToJSON(save), 'utf8');
}

/** Read a save back, validated. Throws `SaveError` on a file this build cannot resume. */
export function readSave(path: string): SaveFile {
  return saveFromJSON(readFileSync(path, 'utf8'));
}
