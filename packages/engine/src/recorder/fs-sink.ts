import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

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
