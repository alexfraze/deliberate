import {
  PROTOCOL_VERSION,
  type RecordedMeter,
  type RecordedTurn,
  type RecordingHeader,
  type RecordingLine,
} from '@deliberate/protocol';

/**
 * The JSONL wire format for a recorded session: one `RecordingHeader` then one `RecordedTurn` per
 * turn, each a single line of JSON. Reading and writing live here so the recorder, the replayer
 * and the CLI all agree on the format; neither this module nor its callers touch the filesystem
 * (see sink.ts).
 */

export class RecordingError extends Error {
  override readonly name = 'RecordingError';
}

export function encodeLine(line: RecordingLine): string {
  return JSON.stringify(line);
}

/** Parse one JSONL line. Throws `RecordingError` on anything that is not a recording line. */
export function parseLine(text: string, at: number): RecordingLine {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new RecordingError(`line ${at} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof value !== 'object' || value === null) {
    throw new RecordingError(`line ${at} is not an object`);
  }
  const line = value as Record<string, unknown>;
  if (line['line'] === 'header') {
    if (line['protocol'] !== PROTOCOL_VERSION) {
      throw new RecordingError(
        `line ${at}: recording protocol ${String(line['protocol'])} != ${PROTOCOL_VERSION}`,
      );
    }
    if (
      typeof line['seed'] !== 'string' ||
      typeof line['hash'] !== 'string' ||
      typeof line['snapshot'] !== 'object' ||
      line['snapshot'] === null
    ) {
      throw new RecordingError(`line ${at}: header needs a seed, a snapshot and a hash`);
    }
    return value as RecordingHeader;
  }
  if (line['line'] === 'turn') {
    if (typeof line['turn'] !== 'number' || !line['intent'] || !line['verdict']) {
      throw new RecordingError(`line ${at}: turn needs a turn number, an intent and a verdict`);
    }
    if (typeof line['hashBefore'] !== 'string' || typeof line['hashAfter'] !== 'string') {
      throw new RecordingError(`line ${at}: turn needs hashBefore and hashAfter`);
    }
    if (!Array.isArray(line['diffs'])) {
      throw new RecordingError(`line ${at}: turn needs a diffs array`);
    }
    return value as RecordedTurn;
  }
  if (line['line'] === 'meter') {
    // Meters are evidence about a turn, not part of it: a malformed one must not cost anybody
    // their recording, so only the field `replay` and the summary index on is required.
    if (typeof line['turn'] !== 'number') {
      throw new RecordingError(`line ${at}: meter needs a turn number`);
    }
    return value as RecordedMeter;
  }
  throw new RecordingError(`line ${at}: unknown line kind ${String(line['line'])}`);
}

/** Split JSONL text into lines, dropping blank ones (a trailing newline is normal). */
export function splitLines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim() !== '');
}

/** Parse a whole recording. */
export function parseRecording(text: string): RecordingLine[] {
  return splitLines(text).map((l, i) => parseLine(l, i + 1));
}
