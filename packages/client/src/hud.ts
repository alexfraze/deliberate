/**
 * The DOM layer over the canvas: the status readout and the floating damage numbers.
 *
 * Damage numbers are DOM rather than sprites on purpose — the scene projects an entity to screen
 * coordinates and the browser does the text, which keeps font handling out of both render
 * backends and costs nothing per frame.
 */
export interface FloatingNumber {
  /** `t` is the animation's normalised time; the number drifts up and fades as it approaches 1. */
  update(x: number, y: number, t: number): void;
  remove(): void;
}

export interface Hud {
  setBackend(backend: string): void;
  setStatus(status: string): void;
  setSelection(selection: string | null): void;
  /** The last reason the server refused an intent. Null clears it. */
  setError(reason: string | null): void;
  /** One line of transient feedback ("Moving to (4, 5)…"). */
  setHint(hint: string | null): void;
  floatNumber(text: string, color: string): FloatingNumber;
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

export function createHud(hudElement: HTMLElement, overlay: HTMLElement): Hud {
  const state = {
    backend: 'starting',
    status: 'connecting',
    selection: null as string | null,
    hint: null as string | null,
    error: null as string | null,
  };

  const render = (): void => {
    const lines = [line('renderer', state.backend), line('server', state.status)];
    lines.push(line('selected', state.selection ?? 'nothing — click an entity'));
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
    setError(reason) {
      state.error = reason;
      render();
    },
    setHint(hint) {
      state.hint = hint;
      render();
    },
    floatNumber(text, color) {
      const element = document.createElement('div');
      element.className = 'float-number';
      element.textContent = text;
      element.style.color = color;
      overlay.appendChild(element);
      return {
        update(x, y, t) {
          element.style.transform = `translate(-50%, -50%) translate(${x}px, ${y - t * 42}px)`;
          element.style.opacity = String(1 - Math.max(0, t - 0.6) / 0.4);
        },
        remove() {
          element.remove();
        },
      };
    },
  };
}
