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
  onGo(handler: () => void): void;
  onToggle(handler: (on: boolean) => void): void;
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
  const prose = element('div', 'dl-preview');
  const reactions = document.createElement('ul');
  reactions.className = 'dl-reactions';
  const narration = element('div', 'dl-narration');

  const go = document.createElement('button');
  go.id = 'go';
  go.type = 'button';
  go.textContent = 'GO';
  go.disabled = true;

  root.append(label, staged, prose, reactions, go, narration);

  let goHandler: (() => void) | null = null;
  go.addEventListener('click', () => goHandler?.());

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
    } else {
      staged.textContent = describeStaged(null, options.nameOf);
    }
  };
  show(false);

  return {
    isOn: () => toggle.checked,
    stage(intent) {
      staged.textContent = describeStaged(intent, options.nameOf);
      prose.textContent = 'the game master is thinking…';
      setReactions([]);
      narration.textContent = '';
      go.disabled = true;
    },
    showPreview(text, diffs) {
      prose.textContent = text;
      setReactions(telegraph(diffs, options.nameOf));
      go.disabled = false;
    },
    committing() {
      prose.textContent = 'resolving…';
      go.disabled = true;
    },
    reset(note) {
      staged.textContent = describeStaged(null, options.nameOf);
      prose.textContent = note ?? '';
      setReactions([]);
      go.disabled = true;
    },
    narrate(chunk, done) {
      if (chunk) narration.textContent = `${narration.textContent ?? ''}${chunk}`;
      if (done) prose.textContent = '';
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
  };
}

function element(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
