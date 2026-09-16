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

// --- who is actually behind the turn (ALE-39) --------------------------------------------------

/**
 * What the server's `/healthz` says about the game master behind this session.
 *
 * The default UI path used to be silent about this: with deliberate mode off a click commits
 * straight to the engine and no model is ever asked, which is indistinguishable on screen from a
 * game master that answered instantly. Everything below turns that into words.
 */
export interface GmAvailability {
  /** False when there is no server to ask — offline fixture mode, or `/healthz` did not answer. */
  server: boolean;
  /** `GM_SERVICE_URL` is set. False means no model is in the loop at all, on either path. */
  configured: boolean;
  /** Configured *and* its own `/healthz` answered. */
  reachable: boolean;
  model: string | null;
  narrateModel: string | null;
}

export const NO_GM: GmAvailability = {
  server: false,
  configured: false,
  reachable: false,
  model: null,
  narrateModel: null,
};

/** True when a click in deliberate mode would really reach Claude. */
export function gmIsLive(gm: GmAvailability | null): boolean {
  return gm !== null && gm.configured && gm.reachable;
}

/** What was consulted for the turn the player just took. */
export type TurnSource =
  /** Nothing has been committed or previewed yet. */
  | 'none'
  /** A click committed straight to the engine: the M0 path, no model. */
  | 'engine'
  /** A preview came back. Nothing has happened, but something was asked. */
  | 'previewed'
  /** GO went out: the turn was resolved (and, with a game master, narrated). */
  | 'committed';

/** The mode line: what the *next* click will do, spelled out rather than implied by a checkbox. */
export function describeMode(on: boolean, gm: GmAvailability | null): string {
  if (!on) return 'engine only — the game master is not consulted';
  if (gm === null) return 'deliberate — clicks are previewed before they happen';
  if (gmIsLive(gm)) return 'deliberate — the game master previews every click before it happens';
  if (!gm.configured) {
    return 'deliberate — but no game master is configured, so a preview is only the engine’s own resolution';
  }
  return 'deliberate — but the game master is not answering, so a preview is only the engine’s own resolution';
}

/** The availability line: is there a model behind this session at all, and which one. */
export function describeGm(gm: GmAvailability | null): string {
  if (gm === null) return 'game master: asking the server…';
  if (!gm.server) return 'game master: unknown — nothing to ask (offline fixture)';
  if (!gm.configured) return 'game master: none — GM_SERVICE_URL is unset, so no model runs';
  if (!gm.reachable) return 'game master: configured but not answering';
  const narration =
    gm.narrateModel && gm.narrateModel !== gm.model ? ` · narration ${gm.narrateModel}` : '';
  return `game master: ${gm.model ?? 'ready'}${narration}`;
}

/**
 * The provenance line — the one that answers "was the game master involved in the turn I just
 * took?" without reading the source, which is what ALE-39 is for.
 */
export function describeTurnSource(source: TurnSource, gm: GmAvailability | null): string {
  const live = gmIsLive(gm);
  switch (source) {
    case 'none':
      return 'this turn: nothing taken yet';
    case 'engine':
      return 'this turn: engine only — the game master was never asked';
    case 'previewed':
      return live
        ? 'this turn: the game master previewed it — nothing has happened yet'
        : 'this turn: the engine previewed it — no game master was asked';
    case 'committed':
      return live
        ? 'this turn: the game master ran it'
        : 'this turn: the engine ran it — no game master was asked';
  }
}

/**
 * Initiative only exists inside an encounter, so outside one "End turn" has nothing to end and
 * the NPCs never act. That was invisible; it is a sentence now.
 */
export function describeEncounter(active: boolean): string {
  return active
    ? 'in an encounter — End turn hands initiative to the NPCs'
    : 'no encounter — there is no initiative, so End turn has nothing to end and the world does not act';
}
