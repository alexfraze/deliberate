/**
 * Click handling as a pure state machine, so the rules ("entity then tile is a move, entity then
 * entity is an attack") are testable without a canvas.
 */
import type { EntityId, Intent, MapExit, MapRecord, Tile } from '@deliberate/protocol';

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
 * Where the selected entity is standing and what map it is standing on, so a click can tell a
 * door from a floor tile (ALE-43). Optional: without it a click behaves exactly as it did before
 * maps had exits, which is what every existing caller and test expects.
 */
export interface PickWorld {
  at: Tile | null;
  map: MapRecord | null;
}

/**
 * Given what is selected and what was clicked, decide the next selection and the intent (if any).
 *
 * - empty space clears the selection
 * - clicking an entity with nothing selected selects it
 * - clicking the selected entity again deselects it
 * - selected entity + its own square, when there is an exit under it -> traverse
 * - selected entity + tile -> move
 * - selected entity + another entity -> attack
 *
 * Clicking the square you are already standing on used to be the one click that could only ever
 * be refused ("is already there") or undo your selection. On an exit it is the click that takes
 * the door, which is why a doorway needs no button of its own.
 *
 * Your own square is checked before anything else because a click on it lands on your *capsule*,
 * not on the floor — found by playing, when the second click on the postern deselected the player
 * instead of walking them through it.
 */
export function resolvePick(
  selected: EntityId | null,
  pick: Pick,
  world?: PickWorld,
): SelectionResult {
  if (pick.kind === 'none') {
    return { selected: null, intent: null, hint: selected ? 'Selection cleared.' : null };
  }
  if (selected !== null && world?.at && world.at.x === pick.tile.x && world.at.y === pick.tile.y) {
    const exit = exitAt(world.map, pick.tile);
    // Your own square, with a way off the map under it — whether the ray hit the floor or you.
    if (exit && (pick.kind === 'tile' || pick.id === selected)) {
      return {
        selected,
        intent: { kind: 'traverse', entity: selected, to: exit.to },
        hint: `Taking ${exit.label ?? exit.to}…`,
      };
    }
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

/** The first exit standing on `tile`, or null. The engine validates it; this only composes it. */
export function exitAt(map: MapRecord | null, tile: Tile): MapExit | null {
  return (map?.exits ?? []).find((exit) => exit.at.x === tile.x && exit.at.y === tile.y) ?? null;
}
