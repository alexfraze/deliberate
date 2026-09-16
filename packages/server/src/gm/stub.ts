import type {
  GmPolicyResponse,
  GmService,
  GmTurnRequest,
  GmTurnResponse,
  MemoryBlocks,
} from './service.js';
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
  /**
   * A policy to hand back, as `POST /turn` would (ALE-37). `code` is opaque to the loop and is
   * only ever passed to `policy()` below, so a script can use it as a name for a behaviour.
   */
  policy?: { code: string; note?: string };
}

/**
 * What the scripted GM does when asked to *run* a policy. The real service runs Python in a
 * sandbox; there is no Python in `pnpm check`, so this plays that part — the same contract
 * (calls go through the same `/gm/tool` door, a program failure is `ok: false`) with the program
 * replaced by a function. Everything the loop does with a policy is therefore exercised in CI:
 * the hit, the refusal, the crash, and the policy that runs and lands nothing.
 */
export type PolicyScript = (code: string, acting: string) => ScriptedTurn | { failed: string };

/** Decides what the GM does this turn. A function, so a script can react to the phase or actor. */
export type GmScript = (request: GmTurnRequest) => ScriptedTurn;

export interface StubGmServiceOptions {
  script: GmScript;
  /** How a saved policy behaves when the loop runs it. Absent means every policy run fails. */
  policyScript?: PolicyScript;
  /** The `/gm/tool` door. Bound to the server's own handler; no network in tests. */
  call: (request: GmToolRequest) => GmToolResponse | Promise<GmToolResponse>;
  /** Narration is delivered in chunks so the loop's streaming path is exercised. */
  chunkSize?: number;
}

const DEFAULT_CHUNK = 48;

export function stubGmService(options: StubGmServiceOptions): GmService {
  /** One scripted batch through the `/gm/tool` door, with the batch-stop discipline. */
  const runCalls = async (
    calls: ScriptedCall[],
    ctx: { session: string; turn: number; token: string | null; label: string },
  ): Promise<{ trace: GmTurnResponse['trace']; stopped: boolean }> => {
    const trace: GmTurnResponse['trace'] = [];
    let stopped = false;
    for (const [index, scripted] of calls.entries()) {
      const input = scripted.input ?? {};
      const callId = `${ctx.label}-${index}`;
      if (stopped) {
        trace.push({
          call_id: callId,
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
        session: ctx.session,
        turn: ctx.turn,
        engineToken: scripted.token ?? ctx.token,
        callId,
        tool: scripted.tool,
        input,
      });
      trace.push({
        call_id: callId,
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
    return { trace, stopped };
  };

  return {
    async policy(request): Promise<GmPolicyResponse> {
      const played = options.policyScript?.(request.code, request.acting);
      // No script, or a script that says this program blew up: the program did not run. That is
      // `ok: false`, which is the loop's cue to retire the policy and ask the model.
      if (!played || 'failed' in played) {
        return { ok: false, error: played?.failed ?? 'no policy script', trace: [] };
      }
      const { trace } = await runCalls(played.calls ?? [], {
        session: request.session,
        turn: request.turn,
        token: request.engine_token,
        label: `policy-${request.turn}`,
      });
      return { ok: true, error: null, trace, stdout: '' };
    },

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
        ...(plan.policy ? { policy: plan.policy } : {}),
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
