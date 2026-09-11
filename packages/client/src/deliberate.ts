/**
 * Preview-then-GO, as a pure state machine (ALE-32).
 *
 * Deliberate → Preview → GO is a *player-facing* loop, so what it needs on the client is a small
 * amount of honest bookkeeping: what is staged, what the game master said would happen, and
 * whether GO is allowed to do anything. None of it is authoritative — every diff in a preview is
 * something that has NOT happened, and the server re-validates all of it against the real engine
 * when GO arrives.
 *
 * Kept apart from the DOM and the renderer so the rules ("changing your mind discards the last
 * preview", "GO is dead until a preview arrives") are unit-testable under node, the way
 * `selection.ts` is.
 */
import type { Diff, EntityId, Intent } from '@deliberate/protocol';

export type DeliberateState =
  /** Deliberate mode is off: a click commits straight away, which is the M0 behaviour. */
  | { phase: 'off' }
  /** On, with nothing staged. */
  | { phase: 'idle' }
  /** A preview has been asked for and the game master is thinking. */
  | { phase: 'thinking'; intent: Intent | null }
  /** The preview came back. This is the only state in which GO does anything. */
  | { phase: 'previewed'; intent: Intent | null; text: string; diffs: Diff[] }
  /** GO has been sent; the server is committing, resolving and narrating. */
  | { phase: 'committing' };

export function initialState(on = false): DeliberateState {
  return on ? { phase: 'idle' } : { phase: 'off' };
}

export function canGo(state: DeliberateState): boolean {
  return state.phase === 'previewed';
}

/** Telegraphed lines for the preview panel: one sentence per diff, in the order they would happen. */
export function telegraph(diffs: readonly Diff[], nameOf: (id: EntityId) => string): string[] {
  const lines: string[] = [];
  for (const diff of diffs) {
    const line = describe(diff, nameOf);
    if (line) lines.push(line);
  }
  return lines;
}

function describe(diff: Diff, nameOf: (id: EntityId) => string): string | null {
  switch (diff.type) {
    case 'EntityMoved':
      return `${nameOf(diff.entity)} moves to (${diff.to.x}, ${diff.to.y}).`;
    case 'DamageApplied':
      return `${nameOf(diff.target)} takes ${diff.amount} damage (${diff.hpAfter} hp left).`;
    case 'ConditionSet':
      return diff.active
        ? `${nameOf(diff.entity)} is ${diff.condition}.`
        : `${nameOf(diff.entity)} is no longer ${diff.condition}.`;
    case 'DialogueLine':
      return `${nameOf(diff.speaker)}: “${diff.text}”`;
    case 'DispositionChanged':
      return `${nameOf(diff.entity)} feels ${diff.value} toward ${nameOf(diff.toward)} — ${diff.reason}.`;
    case 'QuestAdvanced':
      return `The quest ${diff.quest} moves to step ${diff.step}.`;
    case 'FlagSet':
      return `${diff.key} becomes ${JSON.stringify(diff.value)}.`;
    case 'EntitySpawned':
      return `${diff.entity.name} arrives.`;
    case 'FacingChanged':
      return `${nameOf(diff.entity)} turns ${diff.facing}.`;
    // Turn bookkeeping is on the HUD's turn line already; repeating it as prose is noise.
    case 'TurnAdvanced':
    case 'EconomySpent':
      return null;
  }
}

/** One line describing what GO would commit. */
export function describeStaged(intent: Intent | null, nameOf: (id: EntityId) => string): string {
  if (!intent) return 'nothing staged — click a tile or an enemy';
  switch (intent.kind) {
    case 'move':
      return `${nameOf(intent.entity)} → (${intent.to.x}, ${intent.to.y})`;
    case 'attack':
      return `${nameOf(intent.attacker)} attacks ${nameOf(intent.target)} with ${intent.ability}`;
    case 'end_turn':
      return `${nameOf(intent.entity)} ends their turn`;
    default:
      return intent.kind;
  }
}
