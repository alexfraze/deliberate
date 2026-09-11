import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { BankEntry, BankManifest } from './bank.js';
import type { LineSink } from './sink.js';

/**
 * The one module in `@deliberate/engine` that touches the filesystem. It is deliberately outside
 * the engine's pure core: the recorder writes through the `LineSink` interface and never imports
 * this, so engine tests stay I/O free. The server (ALE-13) wires it to `recordings/<ts>.jsonl`.
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
