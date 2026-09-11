import type { RecordedTurn, RecordingLine, StateHash } from '@deliberate/protocol';

import type { CreateEngine, Engine } from '../engine.js';
import { canonicalize } from '../hash/index.js';
import { parseLine, RecordingError } from './jsonl.js';

/**
 * Replay: the determinism check the whole project rests on. A fresh engine is built from the
 * header's snapshot and seed, every recorded intent is re-applied to it in order, and each
 * recorded hash must match the hash the engine actually reaches. Same seed and same intents must
 * replay to identical state hashes; anything else is a determinism bug, and the report says which
 * turn first diverged and how.
 *
 * Nothing here reads a file: the caller passes lines (raw JSONL strings or already-parsed
 * `RecordingLine`s) and the `createEngine` to build from, so replay works in a unit test, in the
 * CLI, and in the acceptance test the same way.
 */

export type DivergenceKind = 'hashBefore' | 'hashAfter' | 'verdict' | 'diffs';

export interface ReplayDivergence {
  /** The recorded turn number that diverged; 0 for the header itself. */
  turn: number;
  kind: DivergenceKind;
  expected: string;
  actual: string;
  /** One sentence a human can read straight out of the CLI. */
  reason: string;
}

export interface ReplayReport {
  ok: boolean;
  /** Turns successfully replayed before the report ended. */
  turns: number;
  /** Hash the replay engine finished on. */
  finalHash: StateHash;
  /** Hash the recording says it should have finished on. */
  recordedHash: StateHash;
  /** The first divergence, or `undefined` when the replay matched throughout. */
  divergence?: ReplayDivergence;
}

export function replay(
  lines: Iterable<string | RecordingLine>,
  createEngine: CreateEngine,
): ReplayReport {
  let engine: Engine | undefined;
  let turns = 0;
  let recordedHash = '';
  let at = 0;

  for (const raw of lines) {
    at += 1;
    const line: RecordingLine = typeof raw === 'string' ? parseLine(raw, at) : raw;

    if (line.line === 'header') {
      if (engine) throw new RecordingError(`line ${at}: a second header in one recording`);
      engine = createEngine(line.snapshot, { seed: line.seed });
      recordedHash = line.hash;
      const actual = engine.hash();
      if (actual !== line.hash) {
        return report(0, actual, line.hash, {
          turn: 0,
          kind: 'hashBefore',
          expected: line.hash,
          actual,
          reason: `the header snapshot hashes to ${short(actual)}, but the recording says ${short(line.hash)}`,
        });
      }
      continue;
    }

    if (!engine) throw new RecordingError(`line ${at}: a turn before the header`);
    const divergence = replayTurn(engine, line);
    recordedHash = line.hashAfter;
    if (divergence) return report(turns, engine.hash(), recordedHash, divergence);
    turns += 1;
  }

  if (!engine) throw new RecordingError('recording has no header');
  return report(turns, engine.hash(), recordedHash || engine.hash());
}

function replayTurn(engine: Engine, line: RecordedTurn): ReplayDivergence | undefined {
  const before = engine.hash();
  if (before !== line.hashBefore) {
    return {
      turn: line.turn,
      kind: 'hashBefore',
      expected: line.hashBefore,
      actual: before,
      reason: `state before turn ${line.turn} is ${short(before)}, recorded as ${short(line.hashBefore)}`,
    };
  }

  const verdict = engine.apply(line.intent);
  if (verdict.ok !== line.verdict.ok) {
    return {
      turn: line.turn,
      kind: 'verdict',
      expected: verdictText(line.verdict.ok, line.verdict.reason),
      actual: verdictText(verdict.ok, verdict.reason),
      reason: `turn ${line.turn} was recorded as ${verdictText(line.verdict.ok, line.verdict.reason)} but replayed as ${verdictText(verdict.ok, verdict.reason)}`,
    };
  }

  const expectedDiffs = canonicalize(line.diffs);
  const actualDiffs = canonicalize(verdict.diff);
  if (expectedDiffs !== actualDiffs) {
    return {
      turn: line.turn,
      kind: 'diffs',
      expected: expectedDiffs,
      actual: actualDiffs,
      reason: `turn ${line.turn} emitted different diffs than were recorded`,
    };
  }

  const after = engine.hash();
  if (after !== line.hashAfter) {
    return {
      turn: line.turn,
      kind: 'hashAfter',
      expected: line.hashAfter,
      actual: after,
      reason: `state after turn ${line.turn} is ${short(after)}, recorded as ${short(line.hashAfter)}`,
    };
  }
  return undefined;
}

function report(
  turns: number,
  finalHash: StateHash,
  recordedHash: StateHash,
  divergence?: ReplayDivergence,
): ReplayReport {
  return {
    ok: !divergence,
    turns,
    finalHash,
    recordedHash,
    ...(divergence ? { divergence } : {}),
  };
}

function verdictText(ok: boolean, reason?: string): string {
  return ok ? 'accepted' : `rejected (${reason ?? 'no reason'})`;
}

/** Hashes are 128 hex characters; nobody reads more than the first few. */
function short(hash: StateHash): string {
  return hash.slice(0, 12);
}
