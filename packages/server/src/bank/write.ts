import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { argv, exit, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  bankExpectation,
  parseRecording,
  type BankManifest,
  type BankSession,
} from '@deliberate/engine';

import { generateBank } from './generate.js';

/**
 * Writes the regression bank (ALE-21) to `recordings/bank/`: the generated recordings, and the
 * manifest that names every entry and the numbers it produced.
 *
 * The manifest is derived, never hand-edited — a hand-typed hash is a hash nobody checked. Run
 * this only when a bank entry is deliberately added or changed, and read the diff: a manifest
 * that moves without an intended rules change is the regression the bank exists to report.
 *
 *   pnpm --filter @deliberate/server bank:write
 */

const here = dirname(fileURLToPath(import.meta.url));
export const BANK_DIR = resolve(here, '../../../..', 'recordings/bank');

/**
 * The one entry nobody can regenerate for free: the committed ten-turn playthrough against
 * `claude-opus-5` from ALE-17. Its bytes are evidence and are never rewritten; only its manifest
 * row is derived from them.
 */
const LIVE: Omit<BankSession, 'expect'> = {
  name: 'm1-acceptance',
  file: 'm1-acceptance.jsonl',
  source: 'live',
  description:
    'The M1 acceptance run (ALE-17): ten player turns against the live model, 56 mutations, the ' +
    'game master talking the yard down instead of swinging. The only entry a model actually ' +
    'wrote, and the reason the bank is worth having — a rules, hash or diff change that a unit ' +
    'test would not notice fails against a real session here, for free, forever.',
  objective: { type: 'QuestAdvanced', where: { quest: 'carry-the-scout' } },
};

export function writeBank(dir: string = BANK_DIR): BankManifest {
  mkdirSync(dir, { recursive: true });
  const generated = generateBank();
  for (const { session, jsonl } of generated) writeFileSync(join(dir, session.file), jsonl);

  const live: BankSession = {
    ...LIVE,
    expect: bankExpectation(
      parseRecording(readFileSync(join(dir, LIVE.file), 'utf8')),
      LIVE.objective,
    ),
  };
  const manifest: BankManifest = { sessions: [live, ...generated.map((g) => g.session)] };
  writeFileSync(join(dir, 'bank.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (argv[1] && /bank[\\/]write\.(ts|js)$/.test(argv[1])) {
  const manifest = writeBank();
  stdout.write(
    `wrote ${manifest.sessions.length} sessions to ${BANK_DIR}\n` +
      manifest.sessions
        .map(
          (s) => `  ${s.name.padEnd(24)} ${s.expect.turns} turns, ${s.expect.rejected} rejected\n`,
        )
        .join(''),
  );
  exit(0);
}
