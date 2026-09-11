import {
  DEFAULT_ROOM,
  PROTOCOL_VERSION,
  type Entity,
  type Intent,
  type RecordedMeter,
  type RecordedTurn,
  type RecordingHeader,
  type RoomId,
  type Seed,
  type StateHash,
  type ToolCallRecord,
  type Verdict,
} from '@deliberate/protocol';

import type { Engine } from '../engine.js';
import { encodeLine } from './jsonl.js';
import { memorySink, type LineSink } from './sink.js';

/**
 * The session recorder: a header naming the starting snapshot, its hash and the seed, then one
 * line per turn carrying the intent, the engine's verdict, the diffs and the hash on either side.
 * That is everything `replay` needs to rebuild the session from the engine alone — no server, no
 * model, no clock.
 *
 * The recorder never reads the filesystem or the wall clock: lines go to a `LineSink` and
 * `startedAt` is supplied by the caller, so the engine package stays pure and a recording made in
 * a test is byte-identical to one made by the server.
 *
 * Rejected intents are recorded too: they are part of what the session did, they change nothing
 * (`hashAfter === hashBefore`), and the acceptance test (ALE-13) replays an illegal move.
 */

export interface RecorderOptions {
  seed: Seed;
  /** ISO timestamp for the header. The engine has no clock; the caller owns the wall clock. */
  startedAt: string;
  room?: RoomId;
  /** Defaults to an in-memory sink, which is what tests want. */
  sink?: LineSink;
  /**
   * The engine's `templates` table, recorded in the header so `replay` can rebuild the same
   * engine. Omitted (or empty) leaves the field off the header entirely, which is what every
   * recording written before ALE-21 looks like.
   */
  templates?: Readonly<Record<string, Entity>>;
}

/** Everything a turn carries beyond the intent and the verdict. All optional; all zero in M0. */
export interface TurnMeta {
  toolCalls?: ToolCallRecord[];
  tokens?: RecordedTurn['tokens'];
  latencyMs?: RecordedTurn['latencyMs'];
}

export interface Recorder {
  /** The header line, already written to the sink when the recorder was created. */
  readonly header: RecordingHeader;
  /** Turns recorded so far; the turn number of the next line is this plus one. */
  readonly turns: number;
  /** Drives the engine and records the turn. Returns the engine's verdict unchanged. */
  apply(intent: Intent, meta?: TurnMeta): Verdict;
  /**
   * Records a turn some other code already applied to the engine — the hook the server's room
   * (ALE-11) uses, where the room owns `engine.apply`. `hashBefore` is the hash from before it
   * applied; the current engine hash is taken as `hashAfter`.
   */
  record(intent: Intent, verdict: Verdict, hashBefore: StateHash, meta?: TurnMeta): RecordedTurn;
  /**
   * Appends one `meter` line: what a player turn cost and how long it took (ALE-24). Separate from
   * `record` because the two are known at different moments — a commit line is written the instant
   * the engine accepts the intent, and the turn's cost is only settled once narration is done.
   * Meters change no state, so this does not advance `turns` and `replay` steps over them.
   */
  meter(entry: Omit<RecordedMeter, 'line'>): RecordedMeter;
  /** Closes the sink. Further calls throw. */
  close(): void;
}

export class RecorderClosedError extends Error {
  override readonly name = 'RecorderClosedError';
}

const NO_TOKENS = { input: 0, output: 0 } as const;
const NO_LATENCY = { preview: 0, validate: 0, resolve: 0, narrate: 0 } as const;

export function createRecorder(engine: Engine, options: RecorderOptions): Recorder {
  const sink = options.sink ?? memorySink();
  let turns = 0;
  let closed = false;

  const header: RecordingHeader = {
    line: 'header',
    protocol: PROTOCOL_VERSION,
    room: options.room ?? DEFAULT_ROOM,
    seed: options.seed,
    startedAt: options.startedAt,
    snapshot: engine.snapshot(),
    hash: engine.hash(),
    ...(options.templates && Object.keys(options.templates).length > 0
      ? { templates: structuredClone(options.templates) as Record<string, Entity> }
      : {}),
  };
  sink.write(encodeLine(header));

  const record = (
    intent: Intent,
    verdict: Verdict,
    hashBefore: StateHash,
    meta?: TurnMeta,
  ): RecordedTurn => {
    if (closed) throw new RecorderClosedError('recorder is closed');
    const line: RecordedTurn = {
      line: 'turn',
      turn: turns + 1,
      hashBefore,
      intent,
      toolCalls: meta?.toolCalls ?? [],
      verdict,
      diffs: verdict.diff,
      hashAfter: engine.hash(),
      tokens: meta?.tokens ?? { ...NO_TOKENS },
      latencyMs: meta?.latencyMs ?? { ...NO_LATENCY },
    };
    sink.write(encodeLine(line));
    turns += 1;
    return line;
  };

  return {
    header,
    get turns() {
      return turns;
    },
    apply(intent, meta) {
      const hashBefore = engine.hash();
      const verdict = engine.apply(intent);
      record(intent, verdict, hashBefore, meta);
      return verdict;
    },
    record,
    meter(entry) {
      if (closed) throw new RecorderClosedError('recorder is closed');
      const line: RecordedMeter = { line: 'meter', ...entry };
      sink.write(encodeLine(line));
      return line;
    },
    close() {
      if (closed) return;
      closed = true;
      sink.close?.();
    },
  };
}
