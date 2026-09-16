/**
 * The DOM layer over the canvas: the status readout, the turn-order strip and the floating damage
 * numbers.
 *
 * Damage numbers are DOM rather than sprites on purpose — the scene projects an entity to screen
 * coordinates and the browser does the text, which keeps font handling out of both render
 * backends and costs nothing per frame. The same argument applies to the initiative chips.
 */
import { healthFraction, type InitiativeView } from './initiative.js';

export interface FloatingNumber {
  /** `t` is the animation's normalised time; the number drifts up and fades as it approaches 1. */
  update(x: number, y: number, t: number): void;
  remove(): void;
}

export interface Hud {
  setBackend(backend: string): void;
  setStatus(status: string): void;
  setSelection(selection: string | null): void;
  /** Whose turn it is and what they have left, straight off the diff stream. Null out of combat. */
  setTurn(turn: string | null): void;
  /** The last reason the server refused an intent. Null clears it. */
  setError(reason: string | null): void;
  /** One line of transient feedback ("Moving to (4, 5)…"). */
  setHint(hint: string | null): void;
  floatNumber(text: string, color: string): FloatingNumber;
  /**
   * The turn-order strip (ALE-19). Whose turn it is was a sentence on the HUD, which is not
   * something you can read mid-fight; this is the same facts as chips you can take in at a
   * glance. Pass the view; outside an encounter there is no order and the strip disappears.
   */
  setInitiative(view: InitiativeView | null): void;
}

function line(label: string, value: string): string {
  return `<span class="hud-label">${label}</span> ${escapeHtml(value)}`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}

/**
 * Renders the turn-order strip into `root`.
 *
 * Rebuilt wholesale on every change rather than diffed: an encounter is four or five chips, the
 * call happens once per animation that finishes, and a full rebuild cannot leave a stale
 * highlight on a chip that is no longer current — which is the only bug this thing can have.
 * Names go in through `textContent`; they are content, some of it from the model.
 */
function renderInitiative(root: HTMLElement, view: InitiativeView | null): void {
  if (!view) {
    root.replaceChildren();
    root.hidden = true;
    return;
  }
  root.hidden = false;
  const round = document.createElement('div');
  round.className = 'init-round';
  round.textContent = `round ${view.round}`;
  const chips = view.chips.map((chip) => {
    const node = document.createElement('div');
    node.className = 'init-chip';
    if (chip.current) node.classList.add('is-current');
    if (chip.next) node.classList.add('is-next');
    if (chip.down) node.classList.add('is-down');

    const name = document.createElement('div');
    name.className = 'init-name';
    name.textContent = chip.name;

    const bar = document.createElement('div');
    bar.className = 'init-bar';
    const fill = document.createElement('div');
    fill.className = 'init-fill';
    fill.style.width = `${Math.round(healthFraction(chip) * 100)}%`;
    bar.appendChild(fill);

    const note = document.createElement('div');
    note.className = 'init-note';
    // Only ever one of these: what the acting entity has left, or why a chip is greyed out, or
    // that this one is up next. Anything more is a second sentence to read mid-fight.
    note.textContent = chip.down
      ? 'down'
      : chip.current
        ? (chip.economy ?? '')
        : chip.next
          ? 'up next'
          : `${chip.hp}/${chip.maxHp}`;

    node.append(name, bar, note);
    return node;
  });
  root.replaceChildren(round, ...chips);
}

export function createHud(hudElement: HTMLElement, overlay: HTMLElement): Hud {
  // Its own element rather than part of the HUD's innerHTML: the strip is structure, and rebuilding
  // it as a string would mean escaping model-authored names by hand on every frame.
  const strip = document.getElementById('initiative') ?? document.createElement('div');
  strip.id = 'initiative';
  strip.hidden = true;
  if (!strip.isConnected) (hudElement.parentElement ?? document.body).appendChild(strip);

  const state = {
    backend: 'starting',
    status: 'connecting',
    selection: null as string | null,
    turn: null as string | null,
    hint: null as string | null,
    error: null as string | null,
  };

  const render = (): void => {
    const lines = [line('renderer', state.backend), line('server', state.status)];
    lines.push(line('selected', state.selection ?? 'nothing — click an entity'));
    // Out of combat there is no initiative at all, so nothing takes a turn and no NPC acts. That
    // was a two-word line a stranger read as "nothing has started yet" (ALE-39).
    lines.push(
      line('turn', state.turn ?? 'exploration — no encounter, so no initiative and no NPC turns'),
    );
    if (state.hint) lines.push(`<span class="hud-hint">${escapeHtml(state.hint)}</span>`);
    if (state.error)
      lines.push(`<span class="hud-error">refused: ${escapeHtml(state.error)}</span>`);
    hudElement.innerHTML = lines.join('<br />');
  };

  render();

  return {
    setBackend(backend) {
      state.backend = backend;
      render();
    },
    setStatus(status) {
      state.status = status;
      render();
    },
    setSelection(selection) {
      state.selection = selection;
      render();
    },
    setTurn(turn) {
      state.turn = turn;
      render();
    },
    setError(reason) {
      state.error = reason;
      render();
    },
    setHint(hint) {
      state.hint = hint;
      render();
    },
    setInitiative(view) {
      renderInitiative(strip, view);
    },
    floatNumber(text, color) {
      const element = document.createElement('div');
      element.className = 'float-number';
      element.textContent = text;
      element.style.color = color;
      overlay.appendChild(element);
      return {
        update(x, y, t) {
          // Starts clear of the head rather than on it: at the moment of impact the capsule and
          // its attacker are overlapping, and a number drawn between them is unreadable.
          element.style.transform = `translate(-50%, -50%) translate(${x}px, ${y - 18 - t * 42}px)`;
          element.style.opacity = String(1 - Math.max(0, t - 0.6) / 0.4);
        },
        remove() {
          element.remove();
        },
      };
    },
  };
}
