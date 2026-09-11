import { resolve } from 'node:path';
import { argv, cwd, env, exit, stderr, stdout } from 'node:process';

import { createEngine } from '../rules/index.js';
import { formatBankReport, runBank, type BankReport } from './bank.js';
import { loadBank, readLines } from './fs-sink.js';
import { RecordingError } from './jsonl.js';
import { replay, type ReplayReport } from './replay.js';

/**
 * `replay <file.jsonl>` — re-runs a recorded session through a fresh engine and exits non-zero if
 * any hash diverges. This is the determinism check a human (or CI, or ALE-13's acceptance test)
 * can run against a recording the server wrote.
 *
 * `bank [dir]` — the same check over the whole regression bank (ALE-21), plus the comparison
 * numbers: per-session pass/fail, turns, verdict rejection rate, turns to objective, and tokens
 * where the recording carries them. Defaults to `recordings/bank`. Needs no key and no network.
 *
 * From the repo root, after `pnpm build`:
 *   pnpm replay recordings/bank/<file>.jsonl
 *   pnpm bank
 * Straight from source, borrowing the server's tsx:
 *   pnpm --filter @deliberate/server exec tsx ../engine/src/recorder/cli.ts replay <file>.jsonl
 */

const USAGE = 'usage: cli.ts replay <file.jsonl> | cli.ts bank [dir]';

/** Where the bank lives, relative to the repo root. */
export const DEFAULT_BANK_DIR = 'recordings/bank';

/** Where the CLI prints. Injected so tests can read the output instead of spraying the run. */
export interface CliOut {
  write(text: string): void;
}

export function main(args: readonly string[], out: CliOut = stdout, err: CliOut = stderr): number {
  const [command, file] = args;
  // pnpm runs scripts with the package as the cwd; INIT_CWD is where the human actually stood.
  const from = env['INIT_CWD'] ?? cwd();
  if (command === 'bank') return bank(resolve(from, file ?? DEFAULT_BANK_DIR), out, err);
  if (command !== 'replay' || !file) {
    err.write(`${USAGE}\n`);
    return 2;
  }
  const path = resolve(from, file);

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

function bank(dir: string, out: CliOut, err: CliOut): number {
  let report: BankReport;
  try {
    report = runBank(loadBank(dir), createEngine);
  } catch (e) {
    err.write(`${dir}: ${e instanceof RecordingError ? e.message : String(e)}\n`);
    return 2;
  }
  (report.ok ? out : err).write(`${formatBankReport(report)}\n`);
  return report.ok ? 0 : 1;
}

// Only when run as a program, never when imported by a test.
if (argv[1] && /recorder[\\/]cli\.(ts|js)$/.test(argv[1])) exit(main(argv.slice(2)));
