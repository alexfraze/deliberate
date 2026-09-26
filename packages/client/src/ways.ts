/**
 * Ways out of here (ALE-51): the exits and frontiers of the map you are standing on, as a list
 * you can read and as the sentences that say what to do with one.
 *
 * The bug this exists for was not a missing feature, it was a missing *rendering*. `MapExit` and
 * `MapFrontier` have carried a human-written `label` since ALE-43 and ALE-44 — "the postern
 * lane", "the lane running on east, out of sight past the spoil heap" — and nothing had ever put
 * one on screen. A player asked "how do I walk off the map? seems like I'm boxed in", and the
 * only way to answer was to query the server over a WebSocket and read out coordinates. Same
 * class of bug as ALE-35, where every `DialogueLine` was folded away unrendered.
 *
 * Two things are different and are kept different all the way through, in the scene and here:
 *
 * - an **exit** leads somewhere that already exists. You take it by standing on it and clicking
 *   your own tile — which no one could guess, so the list says it in words.
 * - a **frontier** is an edge the world has not been written past. There is nothing to traverse
 *   to; walking up to one is what asks the game master to author the other side. With deliberate
 *   mode off no model is ever consulted, so a frontier simply cannot be crossed — and that gets
 *   said out loud, in the spirit of ALE-39's mode lines, rather than failing silently.
 *
 * Split the way `selection.ts` is: `waysOf` and the `describe*` functions are pure and unit-test
 * under node, and only `createWaysPanel` touches the DOM. Labels are model output in the authored
 * case, so they reach the page through `textContent` and never `innerHTML`.
 */
import type { MapRecord, Tile } from '@deliberate/protocol';

export type WayKind = 'exit' | 'frontier';

export interface Way {
  kind: WayKind;
  tile: Tile;
  /** What a player would call it. Model output once a location has been authored. */
  label: string;
  /** The entity whose turn it would be is standing on this tile right now. */
  here: boolean;
}

/**
 * Every way off `map`, with the one under your feet first.
 *
 * `standing` is where the entity a click would move is — the selected one, or the player. It is
 * what turns "there is a door at (1, 10)" into "you are in the doorway", which is the only state
 * in which the click-your-own-tile interaction is available at all.
 */
export function waysOf(map: MapRecord | null, standing: Tile | null): Way[] {
  if (!map) return [];
  const on = (tile: Tile): boolean =>
    standing !== null && standing.x === tile.x && standing.y === tile.y;
  const ways: Way[] = [
    ...(map.exits ?? []).map((exit) => ({
      kind: 'exit' as const,
      tile: { x: exit.at.x, y: exit.at.y },
      label: exit.label ?? exit.to,
      here: on(exit.at),
    })),
    ...(map.frontiers ?? []).map((frontier) => ({
      kind: 'frontier' as const,
      tile: { x: frontier.at.x, y: frontier.at.y },
      label: frontier.label,
      here: on(frontier.at),
    })),
  ];
  // Whatever you are standing on comes first: it is the only one you can act on this instant.
  return ways.sort((a, b) => Number(b.here) - Number(a.here));
}

/** The way at `tile`, or null. Exits win over frontiers; the engine never puts both on one tile. */
export function wayAt(map: MapRecord | null, tile: Tile): Way | null {
  return waysOf(map, tile).find((way) => way.here) ?? null;
}

/**
 * What to do with this one, as an instruction rather than a description.
 *
 * "Click your own tile" is the sentence this whole issue turns on. `resolvePick` has taken a
 * click on your own square as taking the door under it since ALE-43, and nothing anywhere said
 * so — so the one interaction that gets you off the map was reachable only by accident.
 */
export function describeWay(way: Way, deliberateOn: boolean): string {
  const at = `(${way.tile.x}, ${way.tile.y})`;
  if (way.kind === 'exit') {
    return way.here
      ? 'you are standing in it — click your own tile to go through'
      : `walk to ${at}, then click your own tile to go through`;
  }
  if (!deliberateOn) {
    return `${at} · nothing is written past here yet — turn on deliberate mode, or the game master is never asked`;
  }
  return way.here
    ? 'you are at the edge — say where you are going, and the game master writes it'
    : `walk to ${at} and ask the game master what lies beyond`;
}

/** The hover line: what this tile is, and the same instruction, on one line for the HUD. */
export function describeWayHover(way: Way, deliberateOn: boolean): string {
  const kind = way.kind === 'exit' ? 'way out' : 'frontier';
  return `${kind}: ${way.label} — ${describeWay(way, deliberateOn)}`;
}

/**
 * The standing footer. One sentence, and only when it is load-bearing: a frontier with no game
 * master behind the session is an edge that cannot be crossed at all, which is worth saying
 * before the player walks the perimeter looking for a door that will never open.
 */
export function describeWaysMode(ways: readonly Way[], deliberateOn: boolean): string | null {
  if (deliberateOn) return null;
  if (!ways.some((way) => way.kind === 'frontier')) return null;
  return 'A frontier only opens if the game master is consulted. Deliberate mode is off, so no model runs and this edge stays shut.';
}

// --- the panel ---------------------------------------------------------------------------------

export interface WaysPanel {
  /** Rebuild the list. Hidden outright when the map has no way off it: an empty box says nothing. */
  render(ways: readonly Way[], deliberateOn: boolean): void;
}

export interface WaysPanelOptions {
  /** Light up a tile on the board while the pointer is on its row. Null clears the highlight. */
  onHoverTile(tile: Tile | null): void;
  /** Clicking a row points at the tile rather than acting: finding it is the job, not taking it. */
  onPickTile(tile: Tile): void;
}

/**
 * Renders the list into `root`.
 *
 * Rebuilt wholesale on every change, like the turn-order strip: it is two or three rows, and a
 * full rebuild cannot leave "you are standing in it" on a row you have walked away from — which
 * is the only bug this thing can have.
 */
export function createWaysPanel(root: HTMLElement, options: WaysPanelOptions): WaysPanel {
  root.replaceChildren();

  return {
    render(ways, deliberateOn) {
      if (ways.length === 0) {
        root.replaceChildren();
        root.hidden = true;
        return;
      }
      root.hidden = false;

      const title = document.createElement('div');
      title.className = 'way-title';
      title.textContent = 'ways out of here';

      const rows = ways.map((way) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `way-row is-${way.kind}`;
        if (way.here) row.classList.add('is-here');

        // The same distinction the board draws: a closed ring for a door, a broken one for an
        // edge. Drawn with a border rather than a glyph so the legend and the scene cannot drift.
        const glyph = document.createElement('span');
        glyph.className = 'way-glyph';
        glyph.setAttribute('aria-hidden', 'true');

        const body = document.createElement('div');
        body.className = 'way-body';
        const label = document.createElement('div');
        label.className = 'way-label';
        // Model output in the authored case. Text, never markup.
        label.textContent = way.label;
        const note = document.createElement('div');
        note.className = 'way-note';
        note.textContent = describeWay(way, deliberateOn);
        body.append(label, note);

        row.append(glyph, body);
        row.addEventListener('pointerenter', () => options.onHoverTile(way.tile));
        row.addEventListener('pointerleave', () => options.onHoverTile(null));
        row.addEventListener('click', () => options.onPickTile(way.tile));
        return row;
      });

      const mode = describeWaysMode(ways, deliberateOn);
      const footer = document.createElement('div');
      footer.className = 'way-mode';
      if (mode) footer.textContent = mode;

      root.replaceChildren(title, ...rows, ...(mode ? [footer] : []));
    },
  };
}
