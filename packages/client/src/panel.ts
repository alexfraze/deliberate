/**
 * The Deliberate panel: the preview, the telegraphed NPC reactions and the GO button (ALE-32).
 *
 * Narration used to land here too. It does not any more (ALE-35): scene prose is part of the
 * conversation, and the conversation has its own region now — `thread.ts` argues why. What is left
 * on this column is only the controls, which is what stopped a long preview pushing GO off screen.
 *
 * Everything on it is provisional until GO. The panel therefore never touches the view, the scene
 * or the animation queue — it renders text the server sent and emits two events (toggle, GO). The
 * client stays non-authoritative in the strongest sense available: the only way anything here
 * becomes real is a `go` frame and the server's answer.
 *
 * Text goes in through `textContent`, never `innerHTML`: half of what is displayed here is model
 * output, and model output is data.
 */
import type { Diff, EntityId, Intent } from '@deliberate/protocol';

import {
  describeEncounter,
  describeGm,
  describeMode,
  describeStaged,
  describeTurnSource,
  telegraph,
  type GmAvailability,
  type TurnSource,
} from './deliberate.js';

export interface DeliberatePanel {
  /** Whether clicks should preview instead of committing. */
  isOn(): boolean;
  /** A preview has been asked for. */
  stage(intent: Intent | null): void;
  /** The preview came back: prose plus the diffs that have NOT happened. */
  showPreview(text: string, diffs: readonly Diff[]): void;
  /** GO has been sent. */
  committing(): void;
  /** Back to nothing staged — after a commit, or after the server refused. */
  reset(note?: string): void;
  /**
   * The narration stream is running. The words themselves go to the dialogue thread; what the
   * panel still owns is the clock, because "narrating" is the last phase of a turn the player is
   * waiting on, and the preview text has to be cleared when the turn it described is over.
   */
  narrate(chunk: string, done: boolean): void;
  /**
   * Show that the game master is working, with a running clock. A preview takes tens of seconds,
   * and a static line is indistinguishable from a hang — the elapsed count is the affordance that
   * says "still alive". Calling it again re-labels without restarting the clock.
   */
  busy(label: string, timeoutMs?: number): void;
  /** Stop the clock. Safe to call when not busy. */
  idle(): void;
  onGo(handler: () => void): void;
  onToggle(handler: (on: boolean) => void): void;
  /**
   * End the selected entity's turn. Unlike GO this is always available: it is how the player
   * hands initiative to the NPCs, and the engine — not the client — decides whether it is legal.
   */
  onEndTurn(handler: () => void): void;
  /**
   * Wait: let a little time pass and give the world a turn (ALE-41). The out-of-combat companion
   * to End turn — outside an encounter there is no turn to end, but there is time to spend — and
   * like it, always available, because legality is the engine's call and not the client's.
   */
  onWait(handler: () => void): void;
  /** What the player typed, trimmed. Empty string when they typed nothing. */
  text(): string;
  /** Clear the text box — after a turn commits, so speech is not accidentally repeated. */
  clearText(): void;
  /**
   * The player asked the game master something without staging a mechanical action. The protocol
   * allows `intent: null` precisely for this: talk to an NPC, ask what the world does.
   */
  onSpeak(handler: () => void): void;
  /**
   * What the server said about the game master behind it (ALE-39). Until this arrives the panel
   * says it is still asking rather than guessing, because "no game master" and "not yet known"
   * are different claims and only one of them is safe to make.
   */
  setGm(gm: GmAvailability | null): void;
  /**
   * Whether an encounter is running. Outside one there is no initiative, so End turn has nothing
   * to end and no NPC ever acts — which the panel now says out loud.
   */
  setEncounter(active: boolean): void;
  /** Record what was consulted for the turn just taken, for the provenance line. */
  noteTurn(source: TurnSource): void;
}

export interface PanelOptions {
  /** How to name an entity. The view knows; the panel does not keep its own copy of the world. */
  nameOf: (id: EntityId) => string;
}

export function createDeliberatePanel(root: HTMLElement, options: PanelOptions): DeliberatePanel {
  root.replaceChildren();

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.id = 'deliberate-toggle';
  const label = document.createElement('label');
  label.className = 'dl-toggle';
  label.append(toggle, document.createTextNode(' deliberate mode'));

  // Free player text. It reaches the GM as quoted DATA, never as instruction (ALE-33), and the
  // server caps its length. This is what turns "click a tile" into "tell the game master what you
  // want"; every layer below it already accepted `text` before this box existed.
  const speech = document.createElement('textarea');
  speech.id = 'speech';
  speech.rows = 2;
  speech.placeholder = 'Say or ask something… (Enter to send, Shift+Enter for a new line)';

  const say = document.createElement('button');
  say.id = 'say';
  say.type = 'button';
  say.textContent = 'Say / Ask';

  // The three lines ALE-39 exists for. They are outside the `dl-open` gate on purpose: the whole
  // failure was that with deliberate mode OFF the panel said nothing at all, so the player could
  // not tell an engine-only turn from a game master that answered instantly.
  const mode = element('div', 'dl-mode');
  const availability = element('div', 'dl-gm');
  const provenance = element('div', 'dl-source');
  const encounter = element('div', 'dl-encounter');

  const staged = element('div', 'dl-staged');
  const busy = element('div', 'dl-busy');
  const prose = element('div', 'dl-preview');
  const reactions = document.createElement('ul');
  reactions.className = 'dl-reactions';

  const go = document.createElement('button');
  go.id = 'go';
  go.type = 'button';
  go.textContent = 'GO';
  go.disabled = true;

  // Always enabled, and never cleared by `show()`: ending a turn is not part of the
  // deliberate/preview cycle, it is the only way to hand initiative to the NPCs.
  const endTurn = document.createElement('button');
  endTurn.id = 'end-turn';
  endTurn.type = 'button';
  endTurn.textContent = 'End turn';

  // The same, for the other half of the game. Outside an encounter End turn has nothing to end;
  // Wait is what hands the moment to the world instead.
  const wait = document.createElement('button');
  wait.id = 'wait';
  wait.type = 'button';
  wait.textContent = 'Wait';

  root.append(
    label,
    mode,
    availability,
    speech,
    say,
    staged,
    busy,
    prose,
    reactions,
    go,
    endTurn,
    wait,
    encounter,
    provenance,
  );

  // What the panel knows about who is running the turn. None of it is authoritative — it is a
  // report of what the client asked for and what came back.
  let gm: GmAvailability | null = null;
  let source: TurnSource = 'none';
  let inEncounter = false;

  const paintStatus = (): void => {
    mode.textContent = describeMode(toggle.checked, gm);
    availability.textContent = describeGm(gm);
    provenance.textContent = describeTurnSource(source, gm);
    encounter.textContent = describeEncounter(inEncounter);
    // Styling hooks, so "no model ran" reads as a warning rather than as more grey text.
    root.classList.toggle('dl-nogm', gm !== null && !(gm.configured && gm.reachable));
    root.classList.toggle('dl-engine-only', !toggle.checked || source === 'engine');
  };

  const noteTurn = (next: TurnSource): void => {
    source = next;
    paintStatus();
  };

  // The waiting indicator. One interval drives both the spinner and the clock; it is cleared on
  // every exit path so a finished turn can never leave a phantom "still working" on screen.
  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let busyTimer: ReturnType<typeof setInterval> | null = null;
  let busyLabel = '';
  let busyStart = 0;
  let busyFrame = 0;
  // A deadline, refreshed by every `busy()` call. Without one the indicator outlives the work:
  // a plain move outside an encounter produces diffs and then silence -- no narration, no error --
  // so a spinner that only stops on those two signals spins forever and lies to the player.
  let busyDeadline = Number.POSITIVE_INFINITY;

  const paintBusy = (): void => {
    if (Date.now() > busyDeadline) return stopBusy();
    const seconds = (Date.now() - busyStart) / 1000;
    busy.textContent = `${SPINNER[busyFrame % SPINNER.length]} ${busyLabel} · ${seconds.toFixed(1)}s`;
    busyFrame += 1;
  };

  const startBusy = (text: string, timeoutMs?: number): void => {
    busyLabel = text;
    busyDeadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
    if (busyTimer !== null) return paintBusy(); // re-label, keep the clock running
    busyStart = Date.now();
    busyFrame = 0;
    paintBusy();
    busyTimer = setInterval(paintBusy, 100);
  };

  const stopBusy = (): void => {
    if (busyTimer !== null) clearInterval(busyTimer);
    busyTimer = null;
    busyDeadline = Number.POSITIVE_INFINITY;
    busy.textContent = '';
  };

  let goHandler: (() => void) | null = null;
  go.addEventListener('click', () => goHandler?.());
  let endTurnHandler: (() => void) | null = null;
  endTurn.addEventListener('click', () => endTurnHandler?.());
  let waitHandler: (() => void) | null = null;
  wait.addEventListener('click', () => waitHandler?.());
  let speakHandler: (() => void) | null = null;
  say.addEventListener('click', () => speakHandler?.());
  speech.addEventListener('keydown', (event) => {
    // Enter sends, Shift+Enter newlines — the convention every chat box uses.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      speakHandler?.();
    }
  });

  const setReactions = (lines: string[]): void => {
    reactions.replaceChildren(
      ...lines.map((line) => {
        const item = document.createElement('li');
        item.textContent = line;
        return item;
      }),
    );
  };

  const show = (on: boolean): void => {
    root.classList.toggle('dl-open', on);
    if (!on) {
      staged.textContent = '';
      prose.textContent = '';
      setReactions([]);
      go.disabled = true;
      stopBusy();
    } else {
      staged.textContent = describeStaged(null, options.nameOf);
    }
    paintStatus();
  };
  // ON by default (ALE-39). The game master is the premise of the project, and the old default sent
  // every click straight to the engine — so the out-of-the-box experience never called the model
  // once. Turning it off is now the deliberate choice, and the mode line says what that means.
  toggle.checked = true;
  show(toggle.checked);

  return {
    isOn: () => toggle.checked,
    stage(intent) {
      staged.textContent = describeStaged(intent, options.nameOf);
      prose.textContent = '';
      startBusy('the game master is thinking');
      setReactions([]);
      go.disabled = true;
    },
    showPreview(text, diffs) {
      stopBusy();
      prose.textContent = text;
      setReactions(telegraph(diffs, options.nameOf));
      go.disabled = false;
      noteTurn('previewed');
    },
    committing() {
      prose.textContent = '';
      startBusy('resolving the turn');
      go.disabled = true;
      noteTurn('committed');
    },
    reset(note) {
      stopBusy();
      staged.textContent = describeStaged(null, options.nameOf);
      prose.textContent = note ?? '';
      setReactions([]);
      go.disabled = true;
    },
    narrate(chunk, done) {
      if (chunk) startBusy('narrating');
      if (done) {
        stopBusy();
        prose.textContent = '';
      }
    },
    onGo(handler) {
      goHandler = handler;
    },
    onToggle(handler) {
      toggle.addEventListener('change', () => {
        show(toggle.checked);
        handler(toggle.checked);
      });
    },
    setGm(next) {
      gm = next;
      paintStatus();
    },
    setEncounter(active) {
      inEncounter = active;
      paintStatus();
    },
    noteTurn,
    busy(label, timeoutMs) {
      startBusy(label, timeoutMs);
    },
    idle() {
      stopBusy();
    },
    onEndTurn(handler) {
      endTurnHandler = handler;
    },
    onWait(handler) {
      waitHandler = handler;
    },
    text() {
      return speech.value.trim();
    },
    clearText() {
      speech.value = '';
    },
    onSpeak(handler) {
      speakHandler = handler;
    },
  };
}

function element(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
