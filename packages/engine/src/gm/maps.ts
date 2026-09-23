import type {
  AuthorMapIntent,
  MapExit,
  MapFrontier,
  MapObjective,
  MapRecord,
  Tile,
  TileCell,
  Verdict,
} from '@deliberate/protocol';

import { inBounds, isWalkable, path, reachable, tileKey } from '../grid/index.js';
import { accept, describeTile, reject, type EngineContext } from '../rules/context.js';
import type { Store } from '../store/index.js';

/**
 * `author_map` — the game master writes a location, and the engine decides whether it exists
 * (ALE-44, decision 2 of `docs/m4-swarm.md`).
 *
 * This is the same discipline as every other GM mutation — propose, validate, verdict — applied
 * to terrain. **Authored content is validated, never trusted.** The model does not get to author
 * a broken world into existence, and every refusal below carries a reason a player could read on
 * screen, exactly like an illegal move.
 *
 * What is checked, and why each one is worth the code:
 *
 * - **malformed** — the terrain rows must decode to exactly `width * height` cells, every glyph
 *   must be one the engine knows, the id must be free, and the size must be inside the bounds. A
 *   500x500 map would blow both the prompt budget and the state hash; a map whose cell count
 *   lies would have been a store error thrown from somewhere far away from the cause.
 * - **unreachable** — this is the one that matters. Every declared exit and objective is checked
 *   with the engine's own `path()` from the entrance. A location whose objective sits behind a
 *   wall is a broken location.
 * - **disconnected** — every walkable tile must be reachable from the entrance. A walled-off
 *   pocket of floor is dead space the player can see and never stand on. Note that `path()`
 *   limits a step to one level of elevation, so a plateau raised 2 above everything around it is
 *   disconnected too, and is refused for exactly the right reason.
 * - **inconsistent** — a location may only be written beyond a **frontier**: an undefined edge an
 *   existing map already carries. The door exists before the room does, and the engine writes
 *   ALE-43's pair of exits itself, one on each side, so the two ends of a link agree by
 *   construction rather than because the model described both of them the same way.
 * - **dangling** — an exit naming a map that is not loaded, or an objective naming a quest that
 *   does not exist, is a reference to something that was never written. Terrain-only authoring
 *   carries no entity or template references at all: populating a new location is `spawn`, which
 *   is already template-validated, and keeping the two apart is decision 4.
 *
 * Nothing here consumes the seeded RNG and nothing here reads a clock, so authoring is
 * deterministic: the same intent against the same world always produces the same map and the same
 * diff. That is what lets the `MapAuthored` diff carry the map's bytes and replay apply them
 * without ever calling the model.
 */

/** Smallest authored map. Below this there is no room for a door and anywhere to walk to. */
export const MIN_AUTHORED_MAP_SIZE = 4;
/** Largest authored map. The cap the prompt budget and the state hash can both afford. */
export const MAX_AUTHORED_MAP_SIZE = 40;
/** Highest ground an authored tile may sit on; `1`-`9` in the terrain alphabet. */
export const MAX_AUTHORED_ELEVATION = 9;

/** The alphabet `get_state`'s map scope already hands the GM, read back the other way. */
function decodeGlyph(ch: string): TileCell | null {
  if (ch === '#') return { elevation: 0, walkable: false };
  if (ch === '.') return { elevation: 0, walkable: true };
  if (ch >= '1' && ch <= '9') return { elevation: Number(ch), walkable: true };
  return null;
}

function tile(t: Tile): Tile {
  return { x: t.x, y: t.y };
}

export function authorMap(ctx: EngineContext, intent: AuthorMapIntent): Verdict {
  const { store } = ctx;
  const id = intent.id.trim();

  // -- malformed -------------------------------------------------------------------------------
  if (!id) return reject('A location needs an id.');
  if (store.hasMap(id)) return reject(`A location called ${id} already exists.`);
  const sizeReason = checkSize('width', intent.width) ?? checkSize('height', intent.height);
  if (sizeReason) return reject(sizeReason);

  const expected = intent.width * intent.height;
  if (!Array.isArray(intent.terrain) || intent.terrain.length !== intent.height) {
    return reject(
      `${id} declares ${intent.width} x ${intent.height} = ${expected} cells, but its terrain has ${Array.isArray(intent.terrain) ? intent.terrain.length : 0} rows.`,
    );
  }
  const cells: TileCell[] = [];
  for (let y = 0; y < intent.height; y++) {
    const row = intent.terrain[y] ?? '';
    if (row.length !== intent.width) {
      return reject(
        `${id} declares ${intent.width} x ${intent.height} = ${expected} cells, but terrain row ${y} has ${row.length}.`,
      );
    }
    for (let x = 0; x < intent.width; x++) {
      const cell = decodeGlyph(row[x]!);
      if (!cell) {
        return reject(
          `${id} has "${row[x]}" at ${describeTile({ x, y })}; use # for a wall, . for floor, or 1-${MAX_AUTHORED_ELEVATION} for ground raised that high.`,
        );
      }
      cells.push(cell);
    }
  }
  if (cells.length !== expected) {
    return reject(`${id} decoded to ${cells.length} cells, not ${expected}.`);
  }

  const map: MapRecord = { id, width: intent.width, height: intent.height, cells };

  // -- the way in: dangling, then inconsistent -------------------------------------------------
  // `back` is not one exit among several. It is the undefined edge this location was written
  // beyond, and its `at` is the entrance — which is why "exactly one way back, and you arrive at
  // it" needs no rule here: the argument shape says it. The engine writes ALE-43's pair of exits
  // from it, one on each map, so the two ends of the link cannot disagree.
  const entrance = tile(intent.back.at);
  const entranceReason = checkStandable(map, entrance, `${id}'s entrance`);
  if (entranceReason) return reject(entranceReason);

  const destination = store.getMap(intent.back.to);
  if (!destination) {
    return reject(`${id} leads back to a map called ${intent.back.to}, and there is no such map.`);
  }
  const arrive = tile(intent.back.arrive);
  const arriveReason = checkStandable(destination, arrive, `${intent.back.to} at`);
  if (arriveReason) return reject(arriveReason);

  const edges = (destination.frontiers ?? []).map((f) => structuredClone(f));
  const index = edges.findIndex((f) => f.at.x === arrive.x && f.at.y === arrive.y);
  if (index < 0) {
    const already = (destination.exits ?? []).some(
      (e) => e.at.x === arrive.x && e.at.y === arrive.y,
    );
    return reject(
      already
        ? `${intent.back.to}'s way out at ${describeTile(arrive)} already leads somewhere.`
        : `${intent.back.to} has no undefined edge at ${describeTile(arrive)} for ${id} to be written beyond. A location can only be written past an edge that is already there.`,
    );
  }
  const edge = edges[index]!;
  edges.splice(index, 1);
  const backLabel = intent.back.label.trim();
  if (!backLabel) return reject(`The way back to ${intent.back.to} needs a label.`);

  // ALE-43 exits are one-way and come in pairs: the frontier becomes the outbound half on the
  // existing map, and the new map carries the return half.
  const outbound: MapExit = { at: tile(edge.at), to: id, entrance, label: edge.label };
  const exits: MapExit[] = [
    { at: entrance, to: intent.back.to, entrance: arrive, label: backLabel },
  ];
  const seenAt = new Set<string>([tileKey(entrance)]);

  // -- new frontiers: edges for a later call to be written beyond -------------------------------
  if (!Array.isArray(intent.frontiers)) return reject(`${id} needs a list of frontiers.`);
  const newFrontiers: MapFrontier[] = [];
  for (const raw of intent.frontiers) {
    const at = tile(raw.at);
    const reason = checkStandable(map, at, `${id}'s frontier at`);
    if (reason) return reject(reason);
    if (seenAt.has(tileKey(at))) return reject(`${id} has two ways out on ${describeTile(at)}.`);
    seenAt.add(tileKey(at));
    const label = raw.label.trim();
    if (!label) {
      return reject(`The frontier at ${describeTile(at)} needs a label saying what lies that way.`);
    }
    newFrontiers.push({ at, label });
  }

  // -- objectives: dangling --------------------------------------------------------------------
  if (!Array.isArray(intent.objectives)) return reject(`${id} needs a list of objectives.`);
  const objectives: MapObjective[] = [];
  for (const raw of intent.objectives) {
    const at = tile(raw.at);
    const reason = checkStandable(map, at, `${id}'s objective at`);
    if (reason) return reject(reason);
    const note = raw.note.trim();
    if (!note)
      return reject(`The objective at ${describeTile(at)} needs a note saying what it is.`);
    if (raw.quest !== null && !store.getQuest(raw.quest)) {
      return reject(
        `The objective at ${describeTile(at)} names a quest called ${raw.quest}, and there is no such quest.`,
      );
    }
    objectives.push({ at, note, quest: raw.quest });
  }

  // -- unreachable -----------------------------------------------------------------------------
  const budget = map.width * map.height;
  for (const at of [...exits.map((e) => e.at), ...newFrontiers.map((f) => f.at)]) {
    if (path(map, entrance, at, budget) === null) {
      return reject(
        `${id}'s way out at ${describeTile(at)} cannot be walked to from the entrance at ${describeTile(entrance)}.`,
      );
    }
  }
  for (const objective of objectives) {
    if (path(map, entrance, objective.at, budget) === null) {
      return reject(
        `${id}'s objective at ${describeTile(objective.at)} cannot be walked to from the entrance at ${describeTile(entrance)}: "${objective.note}".`,
      );
    }
  }

  // -- disconnected ----------------------------------------------------------------------------
  const seen = reachable(map, entrance, budget);
  let stranded = 0;
  let first: Tile | null = null;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const at = { x, y };
      if (!isWalkable(map, at)) continue;
      if (at.x === entrance.x && at.y === entrance.y) continue;
      if (seen.has(tileKey(at))) continue;
      stranded += 1;
      first ??= at;
    }
  }
  if (first) {
    return reject(
      `${stranded} walkable tile${stranded === 1 ? '' : 's'} of ${id}, starting at ${describeTile(first)}, cannot be reached from the entrance at ${describeTile(entrance)}.`,
    );
  }

  // -- accepted: write the map, and fill in the doors that now lead to it -----------------------
  map.exits = exits;
  map.entrance = entrance;
  map.frontiers = newFrontiers;
  map.objectives = objectives;
  store.setMap(map);
  const linkedExits = [...(destination.exits ?? []).map((e) => structuredClone(e)), outbound];
  store.setMap({ ...destination, exits: linkedExits, frontiers: edges });
  return accept([
    {
      type: 'MapAuthored',
      map: structuredClone(map),
      links: [
        {
          map: destination.id,
          exits: structuredClone(linkedExits),
          frontiers: structuredClone(edges),
        },
      ],
    },
  ]);
}

/** A tile has to be a pair of whole numbers, on the map, and floor. One message for all three. */
function checkStandable(map: MapRecord, at: Tile, what: string): string | null {
  if (!Number.isInteger(at.x) || !Number.isInteger(at.y)) {
    return `${what} is not a tile; write it as [x, y] with whole numbers.`;
  }
  if (!inBounds(map, at)) return `${what} ${describeTile(at)} is off the map.`;
  if (!isWalkable(map, at)) {
    return `${what} ${describeTile(at)} is a wall; nobody could stand there.`;
  }
  return null;
}

function checkSize(name: string, value: number): string | null {
  if (!Number.isInteger(value) || value < MIN_AUTHORED_MAP_SIZE || value > MAX_AUTHORED_MAP_SIZE) {
    return `A location's ${name} must be a whole number between ${MIN_AUTHORED_MAP_SIZE} and ${MAX_AUTHORED_MAP_SIZE}; ${String(value)} is not.`;
  }
  return null;
}

/** The undefined edges of a loaded map: the only tiles an `author_map` call may be written past. */
export function frontiers(store: Store, id: string): MapFrontier[] {
  return (store.getMap(id)?.frontiers ?? []).map((f) => structuredClone(f));
}
