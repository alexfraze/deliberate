/**
 * The speculative preview chooser (ALE-40): the half of the preview cache that decides *what* to
 * warm, and — much more importantly — when to keep its hands in its pockets.
 *
 * ALE-22 built `loop.speculate()` on the server and nothing ever called it, so the cache measured
 * zero hits in every live session: a scripted playthrough never asks the same question twice. A
 * real player does, constantly. They hover an enemy, read the tooltip, think, and click the thing
 * they were already looking at — and a preview takes 27–30 s against an 8 s budget, so the seconds
 * they spend deciding are seconds the answer could have been computing.
 *
 * **Every speculation is a model call and real money.** That single fact writes the whole design:
 *
 * - **Dwell, not movement.** A `pointermove` fires dozens of times a second and means nothing. The
 *   pointer *resting* on one target for `DWELL_MS` is the signal, and jitter must not restart the
 *   clock — a shaky hand resting on one tile is still resting, so an unchanged target leaves the
 *   armed timer alone rather than rearming it.
 * - **Once per intent per turn.** The answer is cached server-side under the same key; asking twice
 *   pays twice for a question already answered.
 * - **A hard ceiling per turn**, mirroring the server's. The client's copy exists to avoid sending
 *   frames that would be dropped anyway; the server's copy is the one that bounds the bill, because
 *   anyone can open a browser console.
 *
 * Kept free of the DOM, the renderer and the transport so the stinginess is unit-testable under
 * node with fake timers, the way `selection.ts` and `deliberate.ts` are.
 */
import type { Intent } from '@deliberate/protocol';

/**
 * How long the pointer must rest before its target is worth paying for. 400 ms is roughly the
 * boundary between "sweeping across the map" and "considering this"; short enough that a decision
 * taken in two seconds still gets a warm cache, long enough that crossing the board on the way
 * somewhere else costs nothing.
 */
export const DWELL_MS = 400;

/** Client-side ceiling per turn. The server enforces its own, and its number is the binding one. */
export const MAX_PER_TURN = 2;

export interface SpeculatorOptions {
  /** Sends one `speculate` frame. The transport decides what a frame is; this only decides when. */
  send: (intent: Intent) => void;
  /** The kill switch. `false` makes every method a no-op, and nothing is ever sent. */
  enabled?: boolean;
  dwellMs?: number;
  maxPerTurn?: number;
}

export interface Speculator {
  /**
   * What the pointer is resting on, as the intent choosing it would compose — or `null` for
   * "nothing worth warming", which includes every reason the caller has to stay quiet: deliberate
   * mode off, a real preview in flight, the camera being dragged, unstaged text in the speech box.
   */
  hover(intent: Intent | null): void;
  /** Disarm without hovering anything: a real frame is going out, or the pointer left the canvas. */
  cancel(): void;
  /** The room moved to a new turn. The world changed, so every cached key did; budget resets. */
  turn(turn: number): void;
  /** Frames sent this turn and whether one is armed. For the HUD and for tests. */
  stats(): { sent: number; armed: boolean; turn: number };
}

/** A stable identity for an intent. The engine's shapes are flat and literal, so JSON is enough. */
function keyOf(intent: Intent): string {
  return JSON.stringify(intent);
}

export function createSpeculator(options: SpeculatorOptions): Speculator {
  const enabled = options.enabled ?? true;
  const dwellMs = options.dwellMs ?? DWELL_MS;
  const maxPerTurn = options.maxPerTurn ?? MAX_PER_TURN;

  /** The intents already paid for this turn. Cleared by `turn`, because the keys change with it. */
  let sent = new Set<string>();
  let turn = -1;
  let armedKey: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const disarm = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    armedKey = null;
  };

  return {
    hover(intent) {
      if (!enabled) return;
      if (!intent) {
        disarm();
        return;
      }
      const key = keyOf(intent);
      // Still resting on the same thing: let the clock keep running. Rearming here would mean a
      // pointer that trembles by one pixel never dwells long enough to speculate at all.
      if (key === armedKey) return;
      disarm();
      if (sent.has(key) || sent.size >= maxPerTurn) return;
      armedKey = key;
      timer = setTimeout(() => {
        timer = null;
        armedKey = null;
        // Re-checked at the moment of spending, not only when the timer was set: the budget may
        // have gone in the meantime.
        if (sent.has(key) || sent.size >= maxPerTurn) return;
        sent.add(key);
        options.send(intent);
      }, dwellMs);
    },
    cancel: disarm,
    turn(next) {
      if (next === turn) return;
      turn = next;
      disarm();
      sent = new Set();
    },
    stats: () => ({ sent: sent.size, armed: armedKey !== null, turn }),
  };
}
