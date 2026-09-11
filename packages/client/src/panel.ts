/**
 * The Deliberate panel: the preview, the telegraphed NPC reactions, the GO button and the
 * narration stream (ALE-32).
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

import { describeStaged, telegraph } from './deliberate.js';

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

  const staged = element('div', 'dl-staged');
  const busy = element('div', 'dl-busy');
  const prose = element('div', 'dl-preview');
  const reactions = document.createElement('ul');
  reactions.className = 'dl-reactions';
  const narration = element('div', 'dl-narration');

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

  root.append(label, staged, busy, prose, reactions, go, endTurn, narration);

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
      narration.textContent = '';
      setReactions([]);
      go.disabled = true;
      stopBusy();
    } else {
      staged.textContent = describeStaged(null, options.nameOf);
    }
  };
  show(false);

  return {
    isOn: () => toggle.checked,
    stage(intent) {
      staged.textContent = describeStaged(intent, options.nameOf);
      prose.textContent = '';
      startBusy('the game master is thinking');
      setReactions([]);
      narration.textContent = '';
      go.disabled = true;
    },
    showPreview(text, diffs) {
      stopBusy();
      prose.textContent = text;
      setReactions(telegraph(diffs, options.nameOf));
      go.disabled = false;
    },
    committing() {
      prose.textContent = '';
      startBusy('resolving the turn');
      go.disabled = true;
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
      if (chunk) narration.textContent = `${narration.textContent ?? ''}${chunk}`;
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
    busy(label, timeoutMs) {
      startBusy(label, timeoutMs);
    },
    idle() {
      stopBusy();
    },
    onEndTurn(handler) {
      endTurnHandler = handler;
    },
  };
}

function element(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
