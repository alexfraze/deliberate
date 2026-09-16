/**
 * Playing a recorded session back through the client (ALE-19).
 *
 * `recordings/bank/*.jsonl` are real sessions — `yard-brawl.jsonl` is a live model-driven fight
 * with two deaths in it. They are the only honest test material for animations: hand-written diffs
 * are whatever the author imagined, and what shipped broken is what the engine actually emits.
 *
 * Pure parsing, deliberately: it turns recording text into the protocol messages a server would
 * have sent, so the same function backs the `?replay=` transport in the browser and a node test
 * that steps the animation queue over every diff of a real fight.
 *
 * Nothing here is authoritative and nothing is re-validated — a recording is a transcript, and the
 * client's job with a transcript is to draw it.
 */
import type { Diff, Snapshot } from '@deliberate/protocol';

export interface ReplayTurn {
  turn: number;
  diffs: Diff[];
  /** The engine's hash after this turn, for the acceptance hook to report. */
  hash: string;
}

export interface RecordedSession {
  snapshot: Snapshot;
  turns: ReplayTurn[];
}

/**
 * Parses a JSONL recording. Unknown line kinds (`meter`, and anything a later milestone adds) are
 * skipped rather than rejected: a recording is append-only and a client that refuses to draw a
 * session because it carries a line it has never heard of is worse than useless.
 */
export function parseRecording(text: string): RecordedSession | null {
  let snapshot: Snapshot | null = null;
  const turns: ReplayTurn[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record['line'] === 'header' && record['snapshot']) {
      snapshot = record['snapshot'] as Snapshot;
      continue;
    }
    if (record['line'] !== 'turn') continue;
    const diffs = Array.isArray(record['diffs']) ? (record['diffs'] as Diff[]) : [];
    // A refused turn recorded no diffs; there is nothing to draw, so it is not a frame.
    if (diffs.length === 0) continue;
    turns.push({
      turn: typeof record['turn'] === 'number' ? record['turn'] : turns.length + 1,
      diffs,
      hash: typeof record['hashAfter'] === 'string' ? record['hashAfter'] : '',
    });
  }
  return snapshot ? { snapshot, turns } : null;
}

/** `?replay=yard-brawl` names a recording in `recordings/bank/`. Empty means no replay. */
export function replayName(search: string, hash = ''): string | null {
  const fromQuery = new URLSearchParams(search).get('replay');
  if (fromQuery) return fromQuery;
  const fromHash = /replay=([\w-]+)/.exec(hash)?.[1];
  return fromHash ?? null;
}
