import type { RecordedMeter, RecordingLine } from '@deliberate/protocol';

/**
 * The session summary over a recording's `meter` lines (ALE-24): p50/p95 after GO, and what a turn
 * cost. This is the number M3's exit criterion is stated in — "p50 after GO < 10 s" — so it is
 * computed in one place, from the recording, and both the CLI and the running server read it here
 * rather than each deciding for itself what a percentile is.
 *
 * It lives in the engine package with the rest of the recorder because a recording must be
 * readable with the engine alone: no server, no model, no key. The prices are not here — a meter
 * line already carries the dollars, computed where the model is known.
 */

export interface Percentiles {
  p50: number;
  p95: number;
  mean: number;
  max: number;
}

export interface MeterSummary {
  /** Turns with a meter line. Zero for a recording made before ALE-24, or with metering off. */
  turns: number;
  /** Wall time from GO to an idle room: validate + resolve + narrate. The MVP target is 10 s. */
  afterGoMs: Percentiles;
  /** Wall time the player waited for a preview. The MVP target is 8 s. */
  previewMs: Percentiles;
  usd: { total: number; perTurn: number };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Model calls, and phases the (state hash, intent) cache answered instead (ALE-22). */
  calls: number;
  cacheHits: number;
  /**
   * Of the above, what warming the cache for actions the player only hovered over cost (ALE-40).
   * Reported apart from `usd` because it is the one line item a *cap* is supposed to bound: if
   * `perTurn` here ever approaches a whole preview, the speculation budget is set too high.
   */
  speculation: { count: number; usd: number; perTurn: number };
}

const NO_PERCENTILES: Percentiles = { p50: 0, p95: 0, mean: 0, max: 0 };

/**
 * The nearest-rank percentile: the smallest recorded value that at least `p` of the sample is at
 * or below. No interpolation, because interpolating invents a turn that never happened — and with
 * ten turns in a session, p95 naming the worst real turn is the honest reading.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? 0;
}

function percentiles(values: number[]): Percentiles {
  if (values.length === 0) return { ...NO_PERCENTILES };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

export function isMeter(line: RecordingLine): line is RecordedMeter {
  return line.line === 'meter';
}

/** Summarises the meter lines of a recording. Lines that are not meters are ignored. */
export function summarize(lines: Iterable<RecordingLine>): MeterSummary {
  const meters = [...lines].filter(isMeter);
  const sum = (pick: (m: RecordedMeter) => number): number =>
    meters.reduce((total, m) => total + pick(m), 0);
  const usd = sum((m) => m.usd);
  return {
    turns: meters.length,
    afterGoMs: percentiles(meters.map((m) => m.latencyMs.afterGo)),
    previewMs: percentiles(meters.map((m) => m.latencyMs.preview)),
    usd: { total: usd, perTurn: meters.length ? usd / meters.length : 0 },
    tokens: {
      input: sum((m) => m.tokens.input),
      output: sum((m) => m.tokens.output),
      cacheRead: sum((m) => m.tokens.cacheRead),
      cacheWrite: sum((m) => m.tokens.cacheWrite),
    },
    calls: sum((m) => m.calls),
    cacheHits: sum((m) => m.cacheHits),
    speculation: {
      count: sum((m) => m.speculations ?? 0),
      usd: sum((m) => m.speculativeUsd ?? 0),
      perTurn: meters.length ? sum((m) => m.speculativeUsd ?? 0) / meters.length : 0,
    },
  };
}

/** The summary as the lines a human reads, from the CLI or a log. */
export function formatSummary(summary: MeterSummary): string {
  if (summary.turns === 0) return 'no meter lines in this recording';
  const { afterGoMs: after, previewMs: preview, tokens } = summary;
  const s = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
  return [
    `turns ${summary.turns}`,
    `after GO   p50 ${s(after.p50)}  p95 ${s(after.p95)}  mean ${s(after.mean)}  max ${s(after.max)}`,
    `preview    p50 ${s(preview.p50)}  p95 ${s(preview.p95)}  mean ${s(preview.mean)}  max ${s(preview.max)}`,
    `cost       $${summary.usd.perTurn.toFixed(4)}/turn  $${summary.usd.total.toFixed(4)} total`,
    `tokens     in ${tokens.input}  out ${tokens.output}  cache read ${tokens.cacheRead}  cache write ${tokens.cacheWrite}`,
    `model calls ${summary.calls}  cache hits ${summary.cacheHits}`,
    `speculation ${summary.speculation.count} warmed  $${summary.speculation.perTurn.toFixed(4)}/turn  $${summary.speculation.usd.toFixed(4)} total`,
  ].join('\n');
}
