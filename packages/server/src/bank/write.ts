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
 * The entries nobody can regenerate for free: ten-turn playthroughs against `claude-opus-5`, each
 * roughly $2 and half an hour. Their bytes are evidence and are never rewritten; only their
 * manifest rows are derived from them. ALE-25's gate is three of these, so there are three, and
 * they are three different stories rather than the same story recorded three times — see
 * `SCRIPTS` in `packages/server/src/acceptance.test.ts`.
 */
const LIVE: Omit<BankSession, 'expect'>[] = [
  {
    name: 'm1-acceptance',
    file: 'm1-acceptance.jsonl',
    source: 'live',
    description:
      'The M1 acceptance run (ALE-17): ten player turns against the live model, 56 mutations, ' +
      'the game master talking the yard down instead of swinging. The first entry a model ' +
      'actually wrote, and the reason the bank is worth having — a rules, hash or diff change ' +
      'that a unit test would not notice fails against a real session here, for free, forever.',
    objective: { type: 'QuestAdvanced', where: { quest: 'carry-the-scout' } },
  },
  {
    name: 'yard-brawl',
    file: 'yard-brawl.jsonl',
    source: 'live',
    description:
      'ALE-25, and the first live recording with a death in it: the player crosses the yard, ' +
      'kills Brannoc where he lies, and is killing Halloran by the end of the tenth turn. Four ' +
      'player attacks, three landed, two fatal. Everything the M1 run could not reach is here — ' +
      'damage, the `dead` condition, initiative wrapping, the action economy spending down — ' +
      'written by a real model rather than by a seeded script, which is the difference between ' +
      'this and `m0-yard-skirmish`. It took three live runs to get: two earlier brawls went after ' +
      "Ilva's 9 hp, needed two landed hits, and got one.",
    objective: { type: 'ConditionSet', where: { condition: 'dead', active: true } },
  },
  {
    name: 'parley',
    file: 'parley.jsonl',
    source: 'live',
    description:
      'ALE-25, the playthrough in which the sword never leaves the scabbard: ten player turns of ' +
      'nothing but speech and movement, and a game master that answers with 28 lines of ' +
      'dialogue, nine flags, eight dispositions and two quest steps — it names the man who cut ' +
      'Brannoc open, gets Ilva to half-vouch, unseals the gate, takes the player as surety and ' +
      'sends a runner up the chain. No encounter ever starts, so no initiative, no action ' +
      'economy and no damage appear anywhere in it, which is exactly what makes it worth keeping ' +
      'beside the other two: it is the only live session that drives the world-authoring tools ' +
      "in bulk, and the only one in which the engine's turn machinery is never touched at all.",
    objective: { type: 'QuestAdvanced', where: { quest: 'carry-the-scout' } },
  },
  {
    name: 'beyond-the-lane',
    file: 'beyond-the-lane.jsonl',
    source: 'live',
    description:
      'ALE-48, the M4 acceptance run: the only session in the bank in which the player leaves ' +
      'the map they started on, and the only live one in which the world grows. Fifteen player ' +
      'turns out of the gatehouse, through the postern, east along the lane to the one undefined ' +
      'edge the game ships with — and there the game master writes `m1-spoil-cut`, a twelve by ' +
      'eight cut through the spoil with a raised heap in the middle of it, two new edges of its ' +
      'own and an objective hung on `carry-the-scout`. The player walks into it, someone the ' +
      'game master spawned there argues with them over a tipped handcart, and then they walk all ' +
      'the way home. Four crossings, one authored location, and a `MapAuthored` diff carrying ' +
      "the whole map's bytes, so every one of those turns replays out of this file with no key, " +
      'no network and no Python. `gatehouse-authoring` proves the same thing about a scripted ' +
      'game master; this proves it about a real one, and adds the half a generator cannot reach ' +
      '— a location chosen, named and populated because of what a player said they were doing.',
    objective: { type: 'MapAuthored' },
  },
];

export function writeBank(dir: string = BANK_DIR): BankManifest {
  mkdirSync(dir, { recursive: true });
  const generated = generateBank();
  for (const { session, jsonl } of generated) writeFileSync(join(dir, session.file), jsonl);

  const live: BankSession[] = LIVE.map((session) => ({
    ...session,
    expect: bankExpectation(
      parseRecording(readFileSync(join(dir, session.file), 'utf8')),
      session.objective,
    ),
  }));
  const manifest: BankManifest = { sessions: [...live, ...generated.map((g) => g.session)] };
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
