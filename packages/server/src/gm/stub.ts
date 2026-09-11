import type { GmService, GmTurnRequest, GmTurnResponse, MemoryBlocks } from './service.js';
import type { GmToolRequest, GmToolResponse } from './tool.js';

/**
 * The scripted game master (decision 6 of docs/m1-swarm.md).
 *
 * There is no `ANTHROPIC_API_KEY` on the build machine, so the whole preview-then-GO loop is built
 * and tested against this: a fake that answers a `/turn` request with a canned list of tool calls
 * and a line of prose. It is not a mock of the loop — it *runs* the loop's discipline, putting
 * every call through the same `/gm/tool` door the Python service uses, honouring the same
 * batch-stop rule, and returning a trace in the same shape. So a test that drives this stub
 * exercises the real engine, the real validation and the real commit path; what it does not
 * exercise is the model's judgement, which is exactly what ALE-17 is for.
 *
 * The stub never says yes on the engine's behalf. A call it scripted may still be rejected — and
 * when it is, the batch stops there, just as it would for the real service.
 */

export interface ScriptedCall {
  tool: string;
  input?: Record<string, unknown>;
  /**
   * Aim this call at an engine other than the one `/turn` named. A correct service always echoes
   * the token it was given; this exists so a test can play a service that does not.
   */
  token?: string;
}

/** What the scripted GM does for one `/turn` request. */
export interface ScriptedTurn {
  calls?: ScriptedCall[];
  narration?: string;
}

/** Decides what the GM does this turn. A function, so a script can react to the phase or actor. */
export type GmScript = (request: GmTurnRequest) => ScriptedTurn;

export interface StubGmServiceOptions {
  script: GmScript;
  /** The `/gm/tool` door. Bound to the server's own handler; no network in tests. */
  call: (request: GmToolRequest) => GmToolResponse | Promise<GmToolResponse>;
  /** Narration is delivered in chunks so the loop's streaming path is exercised. */
  chunkSize?: number;
}

const DEFAULT_CHUNK = 48;

export function stubGmService(options: StubGmServiceOptions): GmService {
  return {
    async turn(request, callOptions): Promise<GmTurnResponse> {
      const plan = options.script(request);
      const calls = plan.calls ?? [];
      const trace: GmTurnResponse['trace'] = [];
      let stopped = false;

      for (const [index, scripted] of calls.entries()) {
        const input = scripted.input ?? {};
        if (stopped) {
          // Batch stop: the model planned this on an assumption the engine has just disproved, so
          // it is reported back rather than executed. docs/gm-service.md, "Inside the loop", 5.
          trace.push({
            call_id: `${request.phase}-${index}`,
            tool: scripted.tool,
            input,
            ok: false,
            reason: 'skipped: an earlier call in this batch was rejected',
            diff: [],
            executed: false,
          });
          continue;
        }
        const response = await options.call({
          session: request.session,
          turn: request.turn,
          engineToken: scripted.token ?? request.engine_token,
          callId: `${request.phase}-${index}`,
          tool: scripted.tool,
          input,
        });
        trace.push({
          call_id: `${request.phase}-${index}`,
          tool: scripted.tool,
          input,
          ok: response.ok,
          kind: response.kind,
          reason: response.reason,
          diff: response.diff,
          result: response.result,
          executed: true,
        });
        if (!response.ok && response.kind === 'mutation') stopped = true;
      }

      const narration = plan.narration ?? '';
      for (const chunk of chunks(narration, options.chunkSize ?? DEFAULT_CHUNK)) {
        callOptions?.onChunk?.(chunk);
      }
      return {
        narration,
        trace,
        stop_reason: stopped ? 'rejected' : 'end_turn',
        memory: nextMemory(request.memory, request.phase),
      };
    },
  };
}

/** Splits on whitespace so a chunk boundary never lands inside a word. */
function chunks(text: string, size: number): string[] {
  if (!text) return [];
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(text.length, at + size);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      if (space > at) end = space + 1;
    }
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

/** The stub persists nothing either; it just proves the blocks make the round trip. */
function nextMemory(memory: MemoryBlocks, phase: string): MemoryBlocks {
  const turns = typeof memory['turns'] === 'number' ? memory['turns'] : 0;
  return { ...memory, turns: turns + 1, last_phase: phase };
}
