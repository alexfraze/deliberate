/**
 * Click handling as a pure state machine, so the rules ("entity then tile is a move, entity then
 * entity is an attack") are testable without a canvas.
 */
import type { EntityId, Intent, Tile } from '@deliberate/protocol';

/** The only ability M0 sends; the engine resolves it against the trimmed SRD weapon table. */
export const DEFAULT_ABILITY = 'longsword';

export type Pick =
  { kind: 'tile'; tile: Tile } | { kind: 'entity'; id: EntityId; tile: Tile } | { kind: 'none' };

export interface SelectionResult {
  selected: EntityId | null;
  intent: Intent | null;
  /** Player-facing sentence for the HUD; null leaves the current line alone. */
  hint: string | null;
}

/**
 * Given what is selected and what was clicked, decide the next selection and the intent (if any).
 *
 * - empty space clears the selection
 * - clicking an entity with nothing selected selects it
 * - clicking the selected entity again deselects it
 * - selected entity + tile -> move
 * - selected entity + another entity -> attack
 */
export function resolvePick(selected: EntityId | null, pick: Pick): SelectionResult {
  if (pick.kind === 'none') {
    return { selected: null, intent: null, hint: selected ? 'Selection cleared.' : null };
  }
  if (pick.kind === 'entity') {
    if (selected === null) {
      return { selected: pick.id, intent: null, hint: `Selected ${pick.id}.` };
    }
    if (selected === pick.id) {
      return { selected: null, intent: null, hint: 'Selection cleared.' };
    }
    return {
      selected,
      intent: { kind: 'attack', attacker: selected, target: pick.id, ability: DEFAULT_ABILITY },
      hint: `Attacking ${pick.id}…`,
    };
  }
  if (selected === null) {
    return { selected: null, intent: null, hint: 'Select an entity first.' };
  }
  return {
    selected,
    intent: { kind: 'move', entity: selected, to: { x: pick.tile.x, y: pick.tile.y } },
    hint: `Moving to (${pick.tile.x}, ${pick.tile.y})…`,
  };
}
