import { summarize, type MeterSummary } from '@deliberate/engine';
import type { RecordedMeter } from '@deliberate/protocol';
import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

/** Re-exported so callers of the loop get the summary type without reaching into the engine. */
export type { MeterSummary };

/**
 * Cost and latency meters (ALE-24). Per-turn tokens, dollars and wall time after GO, as
 * OpenTelemetry spans and as a `meter` line in the session recording.
 *
 * The shape is borrowed from ARC-AGI-3's `duck/h1_observability.py`: measurement is **behaviour
 * neutral and default off**. Nothing here can change a turn's outcome, and `@opentelemetry/api`
 * with no SDK registered returns a no-op tracer, so a server nobody has instrumented pays for a
 * few object allocations per turn and nothing else. Wiring an exporter is a deployment decision,
 * not a code change. (The package is already in the tree as a vitest peer, so it adds no weight.)
 *
 * The recording is the durable half. Spans go wherever spans go; the `meter` line stays in the
 * JSONL beside the turns it measured, so "p50 after GO" can be recomputed months later from the
 * file rather than trusted from whatever printed it at the time.
 */

/**
 * `claude-opus-5` list price, US dollars per million tokens.
 *
 * **Cache reads are counted apart from input on purpose.** They are priced at a tenth of fresh
 * input, and one measured M1 call carried 5454 cached tokens against 90 uncached ones — summing
 * the two would have reported that call at roughly twelve times its real cost, and the prompt
 * caching the service already does would have looked like a liability instead of the win it is.
 */
export const PRICE_PER_MTOK = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } as const;

export type TokenCounts = RecordedMeter['tokens'];
/** A `meter` line before the recorder stamps its `line` field. */
export type TurnMeters = Omit<RecordedMeter, 'line'>;

/**
 * Phases a turn is metered in. `validate` is GO's own synchronous work on the real engine, and
 * `speculate` is a preview nobody asked for (ALE-22) — its tokens are real money and are counted,
 * but nobody waited on it, so it contributes no latency.
 */
export type MeteredPhase = 'preview' | 'validate' | 'resolve' | 'narrate' | 'speculate';

const NO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Anthropic's usage field names, as the GM service passes them through. */
export function tokensFrom(usage: Record<string, number> | undefined): TokenCounts {
  return {
    input: usage?.['input_tokens'] ?? 0,
    output: usage?.['output_tokens'] ?? 0,
    cacheRead: usage?.['cache_read_input_tokens'] ?? 0,
    cacheWrite: usage?.['cache_creation_input_tokens'] ?? 0,
  };
}

export function usdFor(tokens: TokenCounts): number {
  return (
    (tokens.input * PRICE_PER_MTOK.input +
      tokens.output * PRICE_PER_MTOK.output +
      tokens.cacheRead * PRICE_PER_MTOK.cacheRead +
      tokens.cacheWrite * PRICE_PER_MTOK.cacheWrite) /
    1_000_000
  );
}

export interface PhaseReport {
  /** `Date.now()` at the start and end of the phase. Spans are stamped with both. */
  startedAt: number;
  endedAt: number;
  usage?: Record<string, number> | undefined;
  /** True when the (state hash, intent) cache answered and no model call was made (ALE-22). */
  cached?: boolean;
  /** Why the phase produced nothing, if it failed. Marks the span as an error. */
  failed?: string | null;
}

export interface TurnMeter {
  /** Folds one phase into the turn and emits its span. */
  record(phase: MeteredPhase, report: PhaseReport): void;
  /** Closes the turn's span and returns the `meter` line. */
  finish(): TurnMeters;
}

export interface Meters {
  /** Opens a turn's meters. */
  open(turn: number): TurnMeter;
  /** Every finished turn this session, summarised: p50/p95 after GO and cost per turn. */
  summary(): MeterSummary;
}

const TRACER = 'deliberate.gm';

export function createMeters(): Meters {
  const finished: RecordedMeter[] = [];

  return {
    open(turn) {
      const tracer = trace.getTracer(TRACER);
      const tokens: TokenCounts = { ...NO_TOKENS };
      const latencyMs = { preview: 0, validate: 0, resolve: 0, narrate: 0, afterGo: 0 };
      let calls = 0;
      let cacheHits = 0;
      /** The share of the above that the player's pointer spent rather than their click (ALE-40). */
      let speculations = 0;
      let speculativeUsd = 0;
      let openedAt: number | null = null;
      let closedAt = 0;

      return {
        record(phase, report) {
          const ms = Math.max(0, report.endedAt - report.startedAt);
          openedAt ??= report.startedAt;
          closedAt = Math.max(closedAt, report.endedAt);
          // Resolve is many NPC turns and adds up; the others happen once, and when a player
          // previews three times before pressing GO it is the last preview they actually waited
          // on. The tokens of the discarded previews are still counted — that money was spent.
          if (phase === 'resolve') latencyMs.resolve += ms;
          else if (phase !== 'speculate') latencyMs[phase] = ms;

          const phaseTokens = tokensFrom(report.usage);
          for (const key of Object.keys(tokens) as (keyof TokenCounts)[]) {
            tokens[key] += phaseTokens[key];
          }
          if (report.cached) cacheHits += 1;
          else if (phase !== 'validate') calls += 1;
          if (phase === 'speculate' && !report.cached) {
            speculations += 1;
            speculativeUsd += usdFor(phaseTokens);
          }

          const span = tracer.startSpan(`gm.${phase}`, {
            startTime: report.startedAt,
            attributes: {
              ...attributes(turn, phaseTokens),
              'deliberate.phase': phase,
              'deliberate.cache_hit': report.cached === true,
            },
          });
          if (report.failed) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: report.failed });
          }
          span.end(report.endedAt);
        },
        finish() {
          latencyMs.afterGo = latencyMs.validate + latencyMs.resolve + latencyMs.narrate;
          const meter: RecordedMeter = {
            line: 'meter',
            turn,
            latencyMs,
            tokens,
            usd: usdFor(tokens),
            calls,
            cacheHits,
            speculations,
            speculativeUsd,
          };
          const span = tracer.startSpan('gm.turn', {
            startTime: openedAt ?? closedAt,
            attributes: {
              ...attributes(turn, tokens),
              'deliberate.usd': meter.usd,
              'deliberate.after_go_ms': latencyMs.afterGo,
              'deliberate.preview_ms': latencyMs.preview,
              'deliberate.model_calls': calls,
              'deliberate.cache_hits': cacheHits,
            },
          });
          span.end(closedAt);
          finished.push(meter);
          const { line: _line, ...rest } = meter;
          return rest;
        },
      };
    },
    summary: () => summarize(finished),
  };
}

/**
 * Attribute names follow the OpenTelemetry gen-ai semantic conventions where they exist, so a
 * collector that already understands model spans understands these. Cache tokens have no
 * conventional name yet and are namespaced under `deliberate.` rather than guessed at.
 */
function attributes(turn: number, tokens: TokenCounts): Attributes {
  return {
    'gen_ai.system': 'anthropic',
    'gen_ai.usage.input_tokens': tokens.input,
    'gen_ai.usage.output_tokens': tokens.output,
    'deliberate.turn': turn,
    'deliberate.tokens.cache_read': tokens.cacheRead,
    'deliberate.tokens.cache_write': tokens.cacheWrite,
  };
}
