import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PROTOCOL_VERSION, type Intent, type RecordedTurn } from '@deliberate/protocol';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';

import type { CreateEngine, Engine } from '../engine.js';
import { createEngine } from '../rules/index.js';
import { fixtureSnapshot, FIXTURE_PLAYER_ID, FIXTURE_SEED } from '../store/index.js';
import { main, type CliOut } from './cli.js';
import { fileSink, readLines } from './fs-sink.js';
import { parseRecording, RecordingError } from './jsonl.js';
import { createRecorder, RecorderClosedError } from './recorder.js';
import { replay } from './replay.js';
import { memorySink } from './sink.js';

const STARTED_AT = '2026-09-11T00:00:00.000Z';

/** A short scripted session on the fixture map: two moves, an attack, an illegal move, end turn. */
const SCRIPT: Intent[] = [
  { kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x: 5, y: 2 } },
  { kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x: 7, y: 3 } },
  { kind: 'attack', attacker: FIXTURE_PLAYER_ID, target: 'dummy-a', ability: 'longsword' },
  // Illegal: a wall. Recorded all the same, and it must replay as the same rejection.
  { kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x: 0, y: 0 } },
  { kind: 'end_turn', entity: FIXTURE_PLAYER_ID },
];

function recordScript(intents: readonly Intent[] = SCRIPT, seed = FIXTURE_SEED) {
  const sink = memorySink();
  const engine = createEngine(fixtureSnapshot(), { seed });
  const recorder = createRecorder(engine, { seed, startedAt: STARTED_AT, sink });
  const verdicts = intents.map((intent) => recorder.apply(intent));
  recorder.close();
  return { sink, engine, recorder, verdicts };
}

describe('createRecorder', () => {
  it('writes a header then one line per turn', () => {
    const { sink, recorder } = recordScript();
    const lines = parseRecording(sink.text());
    expect(lines).toHaveLength(SCRIPT.length + 1);
    expect(lines[0]).toMatchObject({
      line: 'header',
      protocol: PROTOCOL_VERSION,
      room: 'main',
      seed: FIXTURE_SEED,
      startedAt: STARTED_AT,
    });
    expect(recorder.turns).toBe(SCRIPT.length);
    const turns = lines.slice(1) as RecordedTurn[];
    expect(turns.map((t) => t.turn)).toEqual([1, 2, 3, 4, 5]);
    // Each turn starts where the previous one ended.
    expect(turns[0]!.hashBefore).toBe((lines[0] as { hash: string }).hash);
    for (let i = 1; i < turns.length; i += 1) {
      expect(turns[i]!.hashBefore).toBe(turns[i - 1]!.hashAfter);
    }
  });

  it('records rejected intents, which change nothing', () => {
    const { sink, verdicts } = recordScript();
    const illegal = parseRecording(sink.text()).slice(1)[3] as RecordedTurn;
    expect(verdicts[3]!.ok).toBe(false);
    expect(illegal.verdict.ok).toBe(false);
    expect(illegal.verdict.reason).toBeTypeOf('string');
    expect(illegal.diffs).toEqual([]);
    expect(illegal.hashAfter).toBe(illegal.hashBefore);
  });

  it('is byte-identical for the same seed and the same intents', () => {
    expect(recordScript().sink.text()).toBe(recordScript().sink.text());
  });

  it('has no clock and no randomness of its own: startedAt is the only input from outside', () => {
    const a = recordScript().sink.text();
    const sink = memorySink();
    const engine = createEngine(fixtureSnapshot(), { seed: FIXTURE_SEED });
    const recorder = createRecorder(engine, {
      seed: FIXTURE_SEED,
      startedAt: '1999-01-01T00:00:00.000Z',
      sink,
    });
    SCRIPT.forEach((i) => recorder.apply(i));
    expect(sink.text()).not.toBe(a);
    expect(sink.text().replace('1999-01-01T00:00:00.000Z', STARTED_AT)).toBe(a);
  });

  it('records a turn the caller applied itself (the server room hook)', () => {
    const sink = memorySink();
    const engine = createEngine(fixtureSnapshot(), { seed: FIXTURE_SEED });
    const recorder = createRecorder(engine, { seed: FIXTURE_SEED, startedAt: STARTED_AT, sink });
    // The room owns engine.apply; the recorder only hears about the committed turn.
    const hashBefore = engine.hash();
    const verdict = engine.apply(SCRIPT[0]!);
    const line = recorder.record(SCRIPT[0]!, verdict, hashBefore);
    expect(line.turn).toBe(1);
    expect(line.hashAfter).toBe(engine.hash());
    expect(replay(sink.text().split('\n').filter(Boolean), createEngine).ok).toBe(true);
  });

  it('refuses to write after close', () => {
    const { recorder } = recordScript();
    expect(() => recorder.apply(SCRIPT[0]!)).toThrow(RecorderClosedError);
  });
});

describe('replay', () => {
  it('replays a recorded session to identical state hashes', () => {
    const { sink, engine } = recordScript();
    const report = replay(sink.text().split('\n').filter(Boolean), createEngine);
    expect(report.divergence).toBeUndefined();
    expect(report.ok).toBe(true);
    expect(report.turns).toBe(SCRIPT.length);
    expect(report.finalHash).toBe(engine.hash());
    expect(report.finalHash).toBe(report.recordedHash);
  });

  it('accepts already-parsed lines as well as raw JSONL', () => {
    const { sink } = recordScript();
    expect(replay(parseRecording(sink.text()), createEngine).ok).toBe(true);
  });

  it('replays arbitrary seeded sessions of random intents', () => {
    const tile = fc.record({
      x: fc.integer({ min: 0, max: 11 }),
      y: fc.integer({ min: 0, max: 11 }),
    });
    const arbIntent: fc.Arbitrary<Intent> = fc.oneof(
      tile.map((to) => ({ kind: 'move' as const, entity: FIXTURE_PLAYER_ID, to })),
      fc.constantFrom('dummy-a', 'dummy-b').map((target) => ({
        kind: 'attack' as const,
        attacker: FIXTURE_PLAYER_ID,
        target,
        ability: 'longsword',
      })),
      fc.constant({ kind: 'end_turn' as const, entity: FIXTURE_PLAYER_ID }),
    );
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 8 }),
        fc.array(arbIntent, { minLength: 1, maxLength: 16 }),
        (seed, intents) => {
          const { sink, engine } = recordScript(intents, seed);
          const report = replay(sink.lines, createEngine);
          expect(report.divergence).toBeUndefined();
          expect(report.finalHash).toBe(engine.hash());
          expect(report.turns).toBe(intents.length);
        },
      ),
      { seed: 9090, numRuns: 60 },
    );
  });

  it('reports the first divergence and stops there', () => {
    const { sink } = recordScript();
    const lines = parseRecording(sink.text());
    const turn = lines[3] as RecordedTurn;
    turn.hashAfter = 'f'.repeat(128);
    const report = replay(lines, createEngine);
    expect(report.ok).toBe(false);
    expect(report.turns).toBe(2);
    expect(report.divergence).toMatchObject({ turn: 3, kind: 'hashAfter' });
    expect(report.divergence!.reason).toContain('turn 3');
  });

  it('catches an engine that is not deterministic', () => {
    const { sink } = recordScript();
    let calls = 0;
    // An engine that quietly drifts on the third intent: replay must notice at that turn.
    const drifting: CreateEngine = (initial, options) => {
      const real: Engine = createEngine(initial, options);
      return {
        snapshot: () => real.snapshot(),
        hash: () => real.hash(),
        apply: (intent) => {
          calls += 1;
          return calls === 3 ? { ok: false, reason: 'drifted', diff: [] } : real.apply(intent);
        },
      };
    };
    const report = replay(sink.lines, drifting);
    expect(report.ok).toBe(false);
    expect(report.divergence).toMatchObject({ turn: 3, kind: 'verdict' });
  });

  it('catches a header whose snapshot does not match its hash', () => {
    const { sink } = recordScript();
    const lines = parseRecording(sink.text());
    (lines[0] as { hash: string }).hash = '0'.repeat(128);
    const report = replay(lines, createEngine);
    expect(report.ok).toBe(false);
    expect(report.divergence).toMatchObject({ turn: 0, kind: 'hashBefore' });
  });

  it('rejects malformed recordings loudly', () => {
    expect(() => replay(['not json'], createEngine)).toThrow(RecordingError);
    expect(() => replay(['{"line":"turn"}'], createEngine)).toThrow(RecordingError);
    expect(() => replay([], createEngine)).toThrow(RecordingError);
    const { sink } = recordScript();
    expect(() => replay(sink.lines.slice(1), createEngine)).toThrow(RecordingError);
  });
});

// ---------------------------------------------------------------------------------------------
// The filesystem sink and the CLI. The only tests in the engine that touch a disk, and they stay
// inside a temp directory: everything else runs through the in-memory sink.
// ---------------------------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'deliberate-recorder-'));

/** Captures what the CLI would have printed, instead of spraying it through the test run. */
function captured(): CliOut & { text: string } {
  return {
    text: '',
    write(t) {
      this.text += t;
    },
  };
}
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('fileSink and the replay CLI', () => {
  it('writes a recording a fresh engine replays to identical hashes', () => {
    const path = join(dir, 'session.jsonl');
    const engine = createEngine(fixtureSnapshot(), { seed: FIXTURE_SEED });
    const sink = fileSink(path);
    const recorder = createRecorder(engine, {
      seed: FIXTURE_SEED,
      startedAt: STARTED_AT,
      sink,
    });
    SCRIPT.forEach((intent) => recorder.apply(intent));
    recorder.close();

    const report = replay(readLines(path), createEngine);
    expect(report.ok).toBe(true);
    expect(report.finalHash).toBe(engine.hash());
    const out = captured();
    expect(main(['replay', path], out, out)).toBe(0);
    expect(out.text).toContain(`${report.turns} turn(s) replayed to ${engine.hash()}`);
  });

  it('exits non-zero on divergence and on bad usage', () => {
    const path = join(dir, 'broken.jsonl');
    const { sink } = recordScript();
    const lines = parseRecording(sink.text());
    (lines[2] as RecordedTurn).hashAfter = 'f'.repeat(128);
    const out = fileSink(path);
    lines.forEach((l) => out.write(JSON.stringify(l)));
    out.close?.();

    const diverged = captured();
    expect(main(['replay', path], diverged, diverged)).toBe(1);
    expect(diverged.text).toContain('DIVERGED');
    expect(diverged.text).toContain('turn 2');

    const usage = captured();
    expect(main(['replay'], usage, usage)).toBe(2);
    expect(main(['nonsense', path], usage, usage)).toBe(2);
    expect(main(['replay', join(dir, 'missing.jsonl')], usage, usage)).toBe(2);
    expect(usage.text).toContain('usage:');
  });
});
