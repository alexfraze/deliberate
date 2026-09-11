import { resolve } from 'node:path';
import { argv, cwd, env, exit, stderr, stdout } from 'node:process';

import { createEngine } from '../rules/index.js';
import { readLines } from './fs-sink.js';
import { RecordingError } from './jsonl.js';
import { replay, type ReplayReport } from './replay.js';

/**
 * `replay <file.jsonl>` — re-runs a recorded session through a fresh engine and exits non-zero if
 * any hash diverges. This is the determinism check a human (or CI, or ALE-13's acceptance test)
 * can run against a recording the server wrote.
 *
 * From the repo root, after `pnpm build`:
 *   pnpm --filter @deliberate/engine replay recordings/<file>.jsonl
 * Straight from source, borrowing the server's tsx:
 *   pnpm --filter @deliberate/server exec tsx ../engine/src/recorder/cli.ts replay <file>.jsonl
 */

const USAGE = 'usage: cli.ts replay <file.jsonl>';

/** Where the CLI prints. Injected so tests can read the output instead of spraying the run. */
export interface CliOut {
  write(text: string): void;
}

export function main(args: readonly string[], out: CliOut = stdout, err: CliOut = stderr): number {
  const [command, file] = args;
  if (command !== 'replay' || !file) {
    err.write(`${USAGE}\n`);
    return 2;
  }
  // pnpm runs scripts with the package as the cwd; INIT_CWD is where the human actually stood.
  const path = resolve(env['INIT_CWD'] ?? cwd(), file);

  let report: ReplayReport;
  try {
    report = replay(readLines(path), createEngine);
  } catch (e) {
    err.write(`${path}: ${e instanceof RecordingError ? e.message : String(e)}\n`);
    return 2;
  }

  if (report.ok) {
    out.write(`ok ${path}: ${report.turns} turn(s) replayed to ${report.finalHash}\n`);
    return 0;
  }
  const d = report.divergence!;
  err.write(
    `DIVERGED ${path}\n  turn ${d.turn} (${d.kind}): ${d.reason}\n` +
      `  expected ${d.expected}\n  actual   ${d.actual}\n`,
  );
  return 1;
}

// Only when run as a program, never when imported by a test.
if (argv[1] && /recorder[\\/]cli\.(ts|js)$/.test(argv[1])) exit(main(argv.slice(2)));
