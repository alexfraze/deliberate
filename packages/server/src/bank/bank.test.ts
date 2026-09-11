import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createEngine,
  formatBankReport,
  parseRecording,
  runBank,
  type BankEntry,
  type CreateEngine,
  type Engine,
} from '@deliberate/engine';
import INJECTION_BANK from '@deliberate/contracts/injection-bank.json' with { type: 'json' };
import { loadBank } from '@deliberate/engine/fs';
import type { RecordedTurn, RecordingLine } from '@deliberate/protocol';
import { describe, expect, it } from 'vitest';

import { generateBank } from './generate.js';
import { BANK_DIR } from './write.js';

/**
 * The replay-based regression suite (ALE-21).
 *
 * This is the whole bank, run the way CI runs it: every committed recording replayed through a
 * fresh engine and held to the numbers the manifest wrote down. It needs no key, no network, no
 * Python and no browser, so it lives in `pnpm test` — inside the required `check` job — rather
 * than in a job that can be skipped.
 *
 * The last suite is the one that makes the rest worth anything. A regression suite that only ever
 * passes proves nothing, so the bank is deliberately broken four ways here — a drifting engine, a
 * self-consistent recording of a different world, a moved metric, and a tool call that no longer
 * fits the contract — and each one must turn it red, with a sentence saying what moved.
 */

const bank: BankEntry[] = loadBank(BANK_DIR);

/** The bank as the CLI reports it, for a failure message somebody can act on. */
function why(entries: BankEntry[] = bank, engine: CreateEngine = createEngine): string {
  return formatBankReport(runBank(entries, engine));
}

/** One committed session, parsed. Fresh objects every call, so a test may tamper with them. */
function lines(name: string): RecordingLine[] {
  return parseRecording((bank.find((e) => e.session.name === name)!.lines as string[]).join('\n'));
}

/** Deep copy of one entry with its lines parsed, so a test can tamper with it. */
function clone(name: string): BankEntry {
  const entry = bank.find((e) => e.session.name === name)!;
  return { session: structuredClone(entry.session), lines: lines(name) };
}

describe('the regression bank', () => {
  it('has the three live playthroughs and the generated sessions', () => {
    // ALE-25's gate is stated in playthroughs, so the count is asserted here rather than left to
    // whoever reads the manifest: three sessions a real `claude-opus-5` wrote, each replaying.
    expect(bank.length).toBeGreaterThanOrEqual(8);
    expect(bank.filter((e) => e.session.source === 'live').map((e) => e.session.name)).toEqual([
      'm1-acceptance',
      'yard-brawl',
      'parley',
    ]);
    expect(bank.filter((e) => e.session.source === 'engine').length).toBeGreaterThanOrEqual(5);
  });

  it('covers three different stories, not one story recorded three times', () => {
    // Three recordings of the same beats would be the first recording weighed three times. What
    // makes them three playthroughs is that the world ends up somewhere different in each.
    const live = ['m1-acceptance', 'yard-brawl', 'parley'];
    const hashes = live.map((n) => runBank(bank, createEngine).sessions.find((s) => s.name === n)!);
    expect(new Set(hashes.map((s) => s.metrics.finalHash)).size).toBe(3);

    const diffs = (name: string) =>
      new Set(
        lines(name)
          .filter((l): l is RecordedTurn => l.line === 'turn')
          .flatMap((t) => t.diffs.map((d) => d.type)),
      );
    // The brawl is the live recording with a death in it — the thing ALE-17's run never produced
    // and the reason a second live session was worth the money.
    expect([...diffs('yard-brawl')]).toContain('ConditionSet');
    expect(hashes[1]!.metrics.objectiveTurn).not.toBeNull();
    expect(hashes[1]!.metrics.intents).toContain('attack');
    // The parley never draws: no attack anywhere in it, from the player or the game master.
    expect(hashes[2]!.metrics.intents).not.toContain('attack');
  });

  it('replays every session to identical hashes and identical metrics', () => {
    const report = runBank(bank, createEngine);
    expect(formatBankReport(report)).toContain('ok bank');
    expect(report.ok).toBe(true);
    expect(report.totals.passed).toBe(bank.length);
    // Not a token suite: the bank is a real body of recorded turns.
    expect(report.totals.turns).toBeGreaterThan(80);
  });

  it('covers what one live playthrough could not', () => {
    const report = runBank(bank, createEngine);
    const named = (name: string) => report.sessions.find((s) => s.name === name)!;
    const diffs = (name: string) =>
      new Set(
        lines(name)
          .filter((l): l is RecordedTurn => l.line === 'turn')
          .flatMap((t) => t.diffs.map((d) => d.type)),
      );

    // A death, which the live session never produced.
    expect([...diffs('m0-yard-skirmish')]).toContain('ConditionSet');
    expect(named('m0-yard-skirmish').metrics.objectiveTurn).not.toBeNull();

    // Every mutation the engine knows, refused — and a session that therefore changed nothing.
    const refusals = named('gatehouse-refusals');
    expect(refusals.metrics.rejectionRate).toBe(1);
    expect(refusals.metrics.intents).toEqual([
      'advance_quest',
      'attack',
      'cast',
      'end_turn',
      'move',
      'say',
      'set_disposition',
      'set_flag',
      'spawn',
    ]);
    const [header] = lines('gatehouse-refusals');
    expect(refusals.metrics.finalHash).toBe((header as { hash: string }).hash);

    // An encounter that wrapped initiative twice, with every NPC taking a turn.
    expect(named('gatehouse-initiative').metrics.objectiveTurn).toBe(9);

    // All nine mutation tools through the GM door, including a spawn — which only replays
    // because the header carries the engine's templates.
    expect(named('gatehouse-gm-tools').metrics.tools).toEqual([
      'advance_quest',
      'attack',
      'cast',
      'end_turn',
      'move',
      'say',
      'set_disposition',
      'set_flag',
      'spawn',
    ]);
    expect([...diffs('gatehouse-gm-tools')]).toContain('EntitySpawned');
  });

  /**
   * ALE-36: the injection bank runs with the regression suite. It is not a second suite bolted
   * on — it is an entry in this one, generated from `contracts/injection-bank.json`, the same
   * file `services/gm/tests/test_injection.py` iterates. Python proves the text stays inside the
   * speech fence and never leaks the prompt; this proves that a game master which *obeyed* every
   * one of those texts still could not change the world.
   */
  it('runs the injection bank against the real engine, and nothing moves', () => {
    const injections = INJECTION_BANK.cases;
    expect(injections.length).toBeGreaterThanOrEqual(48);
    const turns = lines('injection-bank').filter((l): l is RecordedTurn => l.line === 'turn');
    const header = lines('injection-bank')[0] as { hash: string };

    // Two turns per case: the player says the adversarial text, then the game master tries the
    // mutation that text was after.
    expect(turns).toHaveLength(injections.length * 2);

    const spoken = turns.filter((t) => t.toolCalls.length === 0);
    const obeyed = turns.filter((t) => t.toolCalls.length > 0);
    expect(spoken).toHaveLength(injections.length);
    expect(obeyed).toHaveLength(injections.length);

    // No unvalidated mutation: every demanded call reached the engine and came back refused,
    // with a reason and no diff.
    for (const turn of obeyed) {
      expect(turn.verdict.ok, `${turn.toolCalls[0]!.name} was accepted`).toBe(false);
      expect(turn.verdict.reason).toBeTruthy();
      expect(turn.diffs).toEqual([]);
      expect(turn.toolCalls[0]!.verdict.ok).toBe(false);
    }
    // Every adversarial text really is in the recording, verbatim, as speech and nothing else.
    for (const [i, injection] of injections.entries()) {
      expect(spoken[i]!.intent, injection.id).toMatchObject({
        kind: 'say',
        speaker: 'player',
        text: injection.text.trim(),
      });
      expect(spoken[i]!.diffs.map((d) => d.type)).toEqual(['DialogueLine']);
    }
    // And the state hash never moved, across every case, from the first line to the last.
    expect(turns.every((t) => t.hashBefore === header.hash && t.hashAfter === header.hash)).toBe(
      true,
    );

    const metrics = runBank(bank, createEngine).sessions.find((s) => s.name === 'injection-bank')!;
    expect(metrics.metrics.rejectionRate).toBe(0.5);
    // An injection bank that reached an objective would be the report of a breach.
    expect(metrics.metrics.objectiveTurn).toBeNull();
    // All nine mutation tools were tried and all nine were refused.
    expect(metrics.metrics.tools).toHaveLength(9);
  });

  it('regenerates the engine-driven entries byte for byte', () => {
    // The generated half of the bank is not evidence to be preserved, it is a function of the
    // engine. If the engine changes, these bytes change — which is the point.
    for (const { session, jsonl } of generateBank()) {
      const committed = readFileSync(join(BANK_DIR, session.file), 'utf8');
      expect(jsonl, `${session.name} no longer generates the bytes in the bank`).toBe(committed);
      expect(session).toEqual(bank.find((e) => e.session.name === session.name)!.session);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The bank must be able to fail. Four deliberate breakages, four red reports.
// ---------------------------------------------------------------------------------------------

describe('a deliberately broken bank', () => {
  it('catches an engine that stops being deterministic', () => {
    // The rules change on the fourth intent, the way a real regression would: quietly.
    let calls = 0;
    const drifting: CreateEngine = (initial, options) => {
      const real: Engine = createEngine(initial, options);
      return {
        snapshot: () => real.snapshot(),
        hash: () => real.hash(),
        rngCalls: () => real.rngCalls(),
        apply: (intent) => {
          calls += 1;
          return calls === 4
            ? { ok: false, reason: 'the rules moved', diff: [] }
            : real.apply(intent);
        },
      };
    };
    const report = runBank(bank, drifting);
    expect(report.ok).toBe(false);
    expect(formatBankReport(report)).toContain('FAIL');
    expect(report.sessions.some((s) => s.failures.some((f) => f.includes('replay diverged')))).toBe(
      true,
    );
  });

  it('catches a session that replays perfectly but describes a different world', () => {
    // A regenerated recording is always self-consistent, so replay alone would pass it. The
    // manifest's final hash is the only thing standing between the bank and a silent rewrite.
    const entry = clone('gatehouse-gm-tools');
    entry.session.expect.finalHash = 'f'.repeat(128);
    const [result] = runBank([entry], createEngine).sessions;
    expect(result!.ok).toBe(false);
    expect(result!.replay.ok).toBe(true);
    expect(result!.failures.join(' ')).toContain('no longer describes the same world');
  });

  it('catches a metric that moved', () => {
    const entry = clone('gatehouse-refusals');
    entry.session.expect.rejected -= 1;
    const [result] = runBank([entry], createEngine).sessions;
    expect(result!.ok).toBe(false);
    expect(result!.failures.join(' ')).toContain('rejected verdicts: 9, the bank says 8');
  });

  it('catches a GM tool contract that no longer matches the recorded calls', () => {
    // The closest thing to "a deliberately broken prompt" that costs nothing to run: the tool
    // schemas in `contracts/gm-tools.json` are part of what the model is sent, and replay cannot
    // see them at all, because replay only ever looks at the intent the engine was given. Here a
    // recorded `say` is rewritten to the argument name a careless rename would produce.
    const entry = clone('gatehouse-gm-tools');
    const turn = (entry.lines as RecordingLine[]).find(
      (l): l is RecordedTurn => l.line === 'turn' && l.toolCalls[0]?.name === 'say',
    )!;
    const call = turn.toolCalls[0]!;
    call.args = { speaker: call.args['npc_id'], text: call.args['text'], to: call.args['to'] };
    const [result] = runBank([entry], createEngine).sessions;
    expect(result!.ok).toBe(false);
    expect(result!.replay.ok).toBe(true);
    expect(result!.failures.join(' ')).toContain('no longer fit the contract');
  });

  it('reports the whole bank, not just the first failure', () => {
    const entries = bank.map((e) => ({
      session: { ...structuredClone(e.session), expect: { ...e.session.expect, turns: -1 } },
      lines: e.lines,
    }));
    const report = runBank(entries, createEngine);
    expect(report.totals.passed).toBe(0);
    expect(report.sessions).toHaveLength(bank.length);
    // One FAIL line per session, plus the bank's own summary line.
    const printed = why(entries).split('\n');
    expect(printed.filter((l) => l.startsWith('FAIL'))).toHaveLength(bank.length + 1);
    expect(printed.at(-1)).toContain(`FAIL bank: 0/${bank.length}`);
  });
});
