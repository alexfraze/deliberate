import {
  gmTool,
  isGmMutationTool,
  type Diff,
  type RecordedTurn,
  type RecordingLine,
  type StateHash,
} from '@deliberate/protocol';

import type { CreateEngine } from '../engine.js';
import { toIntent } from '../gm/execute.js';
import { validateAgainstSchema } from '../gm/validate.js';
import { canonicalize } from '../hash/index.js';
import { parseLine } from './jsonl.js';
import { replay, type ReplayReport } from './replay.js';

/**
 * The replay-based regression suite (ALE-21): a bank of recorded sessions, each replayed through a
 * fresh engine and compared against the numbers the bank says it produced.
 *
 * Everything here runs on the engine alone — no key, no network, no Python, no browser — because
 * that is what makes the bank affordable to run on every push. Three expensive live playthroughs
 * become permanent free regression artifacts; the rest of the bank is generated deterministically
 * from seeded intents (`packages/server/src/bank/generate.ts`).
 *
 * Four things are checked per session, and the bank is red if any of them moves:
 *
 * 1. **Replay.** A fresh engine re-applies the recorded intents and must reach every recorded hash.
 *    This is the hard gate — the M0 exit criterion and the project's determinism rule, applied to a
 *    real session rather than to a unit test's five intents.
 * 2. **The final hash**, against the one written down in the manifest. Replay only proves a
 *    recording is self-consistent; a regenerated recording can be perfectly self-consistent and
 *    still describe a different world. The manifest is the checked-in ground truth that catches it.
 * 3. **The tool contract.** Every recorded GM tool call is re-validated against today's
 *    `contracts/gm-tools.json` and re-mapped through `toIntent`, which must reproduce the intent
 *    the engine was actually given. A renamed argument or a dropped tool fails here immediately —
 *    a recording cannot notice that on its own, because replay only ever looks at the intent.
 * 4. **The metrics** the issue asks prompt and model changes to be compared on: turns, verdict
 *    rejection rate, turns to objective, and tokens and latency where the recording carries them
 *    (a recording written without a cost meter carries zeros, and zeros are reported, not gated).
 */

// ---------------------------------------------------------------------------------------------
// The manifest — recordings/bank/bank.json
// ---------------------------------------------------------------------------------------------

/** What counts as this session reaching its objective: the first diff of `type` matching `where`. */
export interface BankObjective {
  type: Diff['type'];
  /**
   * Field equality on that diff. Keys may be dotted paths into nested fields, so a wrapped
   * encounter is `{ 'initiative.round': 3 }`. Empty means any diff of the type counts.
   */
  where?: Record<string, unknown>;
}

/** The numbers the session produced when it was recorded. Any drift is a regression. */
export interface BankExpectation {
  turns: number;
  rejected: number;
  finalHash: StateHash;
  /** 1-based turn on which the objective was reached, or `null` if the session never got there. */
  objectiveTurn: number | null;
}

export interface BankSession {
  name: string;
  file: string;
  /** `live` was played against the real model and costs money to reproduce; `engine` is generated. */
  source: 'live' | 'engine';
  /** What this entry is in the bank to catch. */
  description: string;
  objective: BankObjective;
  expect: BankExpectation;
}

export interface BankManifest {
  sessions: BankSession[];
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

export interface BankMetrics {
  turns: number;
  accepted: number;
  rejected: number;
  /** Rejections over turns, 0..1, rounded to three places. */
  rejectionRate: number;
  /** Turns the game master caused, i.e. those carrying at least one tool call. */
  gmTurns: number;
  toolCalls: number;
  /** Distinct intent kinds, sorted. */
  intents: string[];
  /** Distinct GM tool names, sorted. */
  tools: string[];
  tokens: { input: number; output: number };
  latencyMs: { preview: number; validate: number; resolve: number; narrate: number };
  objectiveTurn: number | null;
  finalHash: StateHash;
}

export interface BankResult {
  name: string;
  source: BankSession['source'];
  ok: boolean;
  metrics: BankMetrics;
  replay: ReplayReport;
  /** One readable sentence per thing that did not match. Empty when the session passed. */
  failures: string[];
}

export interface BankReport {
  ok: boolean;
  sessions: BankResult[];
  /** Bank-wide totals, the numbers a prompt or model change is judged on. */
  totals: {
    sessions: number;
    passed: number;
    turns: number;
    rejected: number;
    rejectionRate: number;
    tokens: { input: number; output: number };
  };
}

/** One entry as it reaches the runner: the manifest row plus the lines read from its file. */
export interface BankEntry {
  session: BankSession;
  lines: readonly (string | RecordingLine)[];
}

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------

export function runBank(entries: readonly BankEntry[], createEngine: CreateEngine): BankReport {
  const sessions = entries.map((entry) => runBankSession(entry, createEngine));
  const turns = sessions.reduce((a, s) => a + s.metrics.turns, 0);
  const rejected = sessions.reduce((a, s) => a + s.metrics.rejected, 0);
  return {
    ok: sessions.every((s) => s.ok),
    sessions,
    totals: {
      sessions: sessions.length,
      passed: sessions.filter((s) => s.ok).length,
      turns,
      rejected,
      rejectionRate: rate(rejected, turns),
      tokens: {
        input: sessions.reduce((a, s) => a + s.metrics.tokens.input, 0),
        output: sessions.reduce((a, s) => a + s.metrics.tokens.output, 0),
      },
    },
  };
}

export function runBankSession(entry: BankEntry, createEngine: CreateEngine): BankResult {
  const { session } = entry;
  const lines = entry.lines.map((raw, i) =>
    typeof raw === 'string' ? parseLine(raw, i + 1) : raw,
  );
  const turns = lines.filter((l): l is RecordedTurn => l.line === 'turn');
  const metrics = measure(turns, session.objective);
  const report = replay(lines, createEngine);
  const failures: string[] = [];

  // 1. the hard gate
  if (!report.ok) failures.push(`replay diverged: ${report.divergence?.reason ?? 'unknown'}`);

  // 2. the checked-in ground truth
  const expect = session.expect;
  if (report.ok && metrics.finalHash !== expect.finalHash) {
    failures.push(
      `final hash ${short(metrics.finalHash)}, the bank says ${short(expect.finalHash)} — ` +
        `the session replays, but it no longer describes the same world`,
    );
  }

  // 3. the tool contract, re-checked against today's contracts/gm-tools.json
  failures.push(...checkToolCalls(turns));

  // 4. the metrics
  compare(failures, 'turns', metrics.turns, expect.turns);
  compare(failures, 'rejected verdicts', metrics.rejected, expect.rejected);
  compare(failures, 'turns to objective', metrics.objectiveTurn, expect.objectiveTurn);

  return {
    name: session.name,
    source: session.source,
    ok: failures.length === 0,
    metrics,
    replay: report,
    failures,
  };
}

function compare(
  failures: string[],
  label: string,
  actual: number | null,
  expected: number | null,
): void {
  if (actual !== expected)
    failures.push(`${label}: ${String(actual)}, the bank says ${String(expected)}`);
}

/**
 * A recorded tool call is a claim about the contract: *this* tool, with *these* arguments, became
 * *that* intent. Replay never re-tests it, because replay only reads `intent`. So the bank does:
 * a tool that no longer exists, an argument the schema no longer accepts, or a mapping that now
 * produces a different intent all fail here, which is how a change to the GM contract or prompt
 * reaches a suite made of recordings.
 */
function checkToolCalls(turns: readonly RecordedTurn[]): string[] {
  const failures: string[] = [];
  for (const turn of turns) {
    for (const call of turn.toolCalls) {
      const at = `turn ${turn.turn} tool ${call.name}`;
      const definition = gmTool(call.name);
      if (!definition) {
        failures.push(`${at}: the contract no longer has a tool called ${call.name}`);
        continue;
      }
      if (!isGmMutationTool(call.name)) {
        failures.push(`${at}: a query tool was recorded as a mutation`);
        continue;
      }
      const reason = validateAgainstSchema(definition.input_schema, call.args, '');
      if (reason) {
        failures.push(`${at}: the recorded arguments no longer fit the contract: ${reason}`);
        continue;
      }
      const intent = toIntent(call.name, call.args);
      if (!intent || canonicalize(intent) !== canonicalize(turn.intent)) {
        failures.push(
          `${at}: maps to ${intent ? canonicalize(intent) : 'no intent'}, ` +
            `but the engine was given ${canonicalize(turn.intent)}`,
        );
      }
      if (call.verdict.ok !== turn.verdict.ok) {
        failures.push(`${at}: the tool call's verdict disagrees with the turn's`);
      }
    }
  }
  return failures;
}

function measure(turns: readonly RecordedTurn[], objective: BankObjective): BankMetrics {
  const rejected = turns.filter((t) => !t.verdict.ok).length;
  const gmTurns = turns.filter((t) => t.toolCalls.length > 0);
  const sum = (pick: (t: RecordedTurn) => number): number => turns.reduce((a, t) => a + pick(t), 0);
  return {
    turns: turns.length,
    accepted: turns.length - rejected,
    rejected,
    rejectionRate: rate(rejected, turns.length),
    gmTurns: gmTurns.length,
    toolCalls: sum((t) => t.toolCalls.length),
    intents: [...new Set(turns.map((t) => t.intent.kind))].sort(),
    tools: [...new Set(gmTurns.flatMap((t) => t.toolCalls.map((c) => c.name)))].sort(),
    tokens: { input: sum((t) => t.tokens.input), output: sum((t) => t.tokens.output) },
    latencyMs: {
      preview: sum((t) => t.latencyMs.preview),
      validate: sum((t) => t.latencyMs.validate),
      resolve: sum((t) => t.latencyMs.resolve),
      narrate: sum((t) => t.latencyMs.narrate),
    },
    objectiveTurn: objectiveTurn(turns, objective),
    finalHash: turns.at(-1)?.hashAfter ?? '',
  };
}

/** The 1-based turn on which the objective diff first appears, or null if it never does. */
function objectiveTurn(turns: readonly RecordedTurn[], objective: BankObjective): number | null {
  const where = Object.entries(objective.where ?? {});
  for (const turn of turns) {
    if (!turn.verdict.ok) continue;
    for (const diff of turn.diffs) {
      if (diff.type !== objective.type) continue;
      if (where.every(([k, v]) => canonicalize(at(diff, k)) === canonicalize(v ?? null))) {
        return turn.turn;
      }
    }
  }
  return null;
}

/** `initiative.round` into a diff; `null` for anything missing, so a bad path never throws. */
function at(value: unknown, path: string): unknown {
  let here: unknown = value;
  for (const key of path.split('.')) {
    if (typeof here !== 'object' || here === null) return null;
    here = (here as Record<string, unknown>)[key];
  }
  return here ?? null;
}

function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 1000) / 1000;
}

function short(hash: StateHash): string {
  return hash.slice(0, 12);
}

/**
 * The numbers a freshly written recording produced, ready to be stored in the manifest. The bank
 * is generated, not hand-maintained: `generate.ts` writes the recordings and derives their rows
 * with this, and the test then holds both to the committed copy.
 */
export function bankExpectation(
  lines: readonly RecordingLine[],
  objective: BankObjective,
): BankExpectation {
  const m = measure(
    lines.filter((l): l is RecordedTurn => l.line === 'turn'),
    objective,
  );
  return {
    turns: m.turns,
    rejected: m.rejected,
    finalHash: m.finalHash,
    objectiveTurn: m.objectiveTurn,
  };
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

/** Per-session pass/fail plus the comparison numbers, as the CLI prints them. */
export function formatBankReport(report: BankReport): string {
  const rows = report.sessions.map((s) => {
    const head =
      `${s.ok ? 'ok  ' : 'FAIL'} ${s.name.padEnd(26)} ${String(s.metrics.turns).padStart(4)} turns  ` +
      `${String(s.metrics.rejected).padStart(3)} rejected (${s.metrics.rejectionRate})  ` +
      `objective ${s.metrics.objectiveTurn === null ? 'not reached' : `turn ${s.metrics.objectiveTurn}`}  ` +
      `${short(s.metrics.finalHash)}` +
      (s.metrics.tokens.input || s.metrics.tokens.output
        ? `  tokens ${s.metrics.tokens.input}/${s.metrics.tokens.output}`
        : '');
    return [head, ...s.failures.map((f) => `       ${f}`)].join('\n');
  });
  const t = report.totals;
  return [
    ...rows,
    `${report.ok ? 'ok' : 'FAIL'} bank: ${t.passed}/${t.sessions} sessions, ${t.turns} turns, ` +
      `${t.rejected} rejected (${t.rejectionRate})`,
  ].join('\n');
}
