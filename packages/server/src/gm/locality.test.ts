import { describe, expect, it } from 'vitest';

import {
  PROTOCOL_VERSION,
  type Entity,
  type EntityId,
  type Snapshot,
  type Tile,
} from '@deliberate/protocol';

import {
  AMBIENT_VICINITY_FT,
  ambientCandidates,
  distanceToPlayer,
  senseOf,
  type AmbientOptions,
  type AmbientSense,
} from './ambient.js';

/**
 * ALE-45's second half: **the world does not get quieter as it gets bigger.**
 *
 * `ambient.ts` lets one NPC act per quiet turn, and that bound is the whole reason a quiet minute
 * is affordable (`MAX_AMBIENT_ACTORS`). It is also the thing M4 could quietly ruin. One turn
 * shared between three neighbours is a living gatehouse. One turn shared between three hundred
 * people scattered over thirty maps is a photograph with a rumour in it — and it would arrive as
 * a *feature*, in the milestone whose whole point is a bigger world.
 *
 * The measure is not "did an NPC act": an NPC acting on the far side of a district the player has
 * not walked into is a model call the player never learns about, which is the cost this milestone
 * is trying not to grow. The measure is how often somebody acts **in the player's scene**.
 *
 * The experiment holds the scene constant and grows everything else. Every world below has the
 * same three people standing with the player in the same small room; what changes is how many
 * strangers there are elsewhere — first across a wide map, then across ten maps, then thirty. So
 * a fall in the rate cannot be blamed on the fixture thinning out. It can only be the rotation
 * being spent on people the player is not with, which is precisely the failure ALE-45 names.
 *
 * Nothing here runs the model, the engine or the room. `ambientCandidates` is a pure function of
 * a snapshot, which is what makes a three-hundred-NPC session a millisecond rather than an
 * afternoon.
 */

/** The room the player is in, in tiles. Three neighbours and the player share it. */
const ROOM = 8;

/** What counts as being in the scene: two moves, the far side of a room. */
const SEEN_FT = 60;

/** Tiles across the player's map. An authored district, not the gatehouse's courtyard. */
const WIDTH = 60;

/** Strangers on the player's own map stand out here, past any plausible sight line. */
const FAR_FROM = 30;

/** Long enough that the idle drum comes round for everybody several times. */
const TURNS = 120;

interface WorldSize {
  label: string;
  /** In the room with the player. The same in every world: this is the controlled variable. */
  near: number;
  /** Elsewhere on the player's map. */
  farOnMap: number;
  /** Other maps, and how many people are on each. */
  otherMaps: number;
  perOtherMap: number;
}

/** Today's world, and three the world-expansion milestone makes possible. */
const SIZES: WorldSize[] = [
  { label: 'the gatehouse as it is', near: 3, farOnMap: 0, otherMaps: 0, perOtherMap: 0 },
  { label: 'one wide district', near: 3, farOnMap: 27, otherMaps: 0, perOtherMap: 0 },
  { label: 'ten maps', near: 3, farOnMap: 27, otherMaps: 9, perOtherMap: 12 },
  { label: 'thirty maps', near: 3, farOnMap: 27, otherMaps: 29, perOtherMap: 12 },
];

const PLAYER: EntityId = 'pc:ari';
const HOME = 'map:0';

/** What ALE-41 shipped: the player's map is the only bound. Kept as the before-and-after control. */
const WHOLE_MAP: AmbientOptions = { vicinityFt: Infinity };

function entity(id: EntityId, name: string, map: string, at: Tile, policy: string): Entity {
  return {
    id,
    name,
    components: {
      brain: { policy },
      position: { map, x: at.x, y: at.y },
      health: { hp: 11, maxHp: 14, conditions: [] },
      disposition: { toward: policy === 'player' ? {} : { [PLAYER]: 10 } },
    },
  };
}

function world(size: WorldSize): Snapshot {
  const entities: Record<EntityId, Entity> = {};
  const add = (id: EntityId, map: string, at: Tile): void => {
    entities[id] = entity(id, `Person ${id}`, map, at, 'gm');
  };

  entities[PLAYER] = entity(PLAYER, 'Ari', HOME, { x: 1, y: 1 }, 'player');
  for (let n = 0; n < size.near; n += 1) add(`npc:near:${n}`, HOME, scatter(n, ROOM, 0));
  for (let n = 0; n < size.farOnMap; n += 1) {
    add(`npc:far:${n}`, HOME, scatter(n, WIDTH - FAR_FROM, FAR_FROM));
  }
  for (let m = 1; m <= size.otherMaps; m += 1) {
    for (let n = 0; n < size.perOtherMap; n += 1) {
      add(`npc:${m}:${n}`, `map:${m}`, scatter(n, WIDTH, 0));
    }
  }
  return {
    schema: PROTOCOL_VERSION,
    entities,
    world: { flags: {}, quests: {}, clock: 0, maps: {} },
    initiative: null,
  };
}

/** Deterministic scatter over `[from, from + span)`. Low-discrepancy, so nobody stacks up. */
function scatter(index: number, span: number, from: number): Tile {
  const golden = 0.6180339887;
  return {
    x: from + Math.floor(((index * golden) % 1) * span),
    y: from + Math.floor(((index * golden * 2) % 1) * span),
  };
}

interface Measured {
  /** Turns on which anybody acted at all. */
  acted: number;
  /** Turns on which somebody acted in the player's scene. This is the number that matters. */
  seen: number;
  /** Distinct people the player saw act. */
  faces: number;
}

/**
 * Play `TURNS` quiet turns and count what the player would have noticed.
 *
 * The player paces the room rather than standing still, because standing still is the one case
 * the idle drum already covers. `acted` is `loop.ts`'s own bookkeeping — the reading each NPC last
 * took a turn on — reproduced exactly, because it is what stops an NPC acting twice for one
 * reason, and dropping it would flatter any selection rule.
 */
function measure(size: WorldSize, options: AmbientOptions = {}): Measured {
  const snapshot = world(size);
  const acted = new Map<EntityId, AmbientSense>();
  const faces = new Set<EntityId>();
  const out: Measured = { acted: 0, seen: 0, faces: 0 };
  const position = snapshot.entities[PLAYER]!.components.position!;

  for (let turn = 0; turn < TURNS; turn += 1) {
    const [candidate] = ambientCandidates(snapshot, acted, options);
    if (candidate) {
      out.acted += 1;
      acted.set(candidate.entity, candidate.sense);
      if (distanceToPlayer(snapshot, candidate.entity, PLAYER) <= SEEN_FT) {
        out.seen += 1;
        faces.add(candidate.entity);
      }
    }
    position.x = pace(turn);
    position.y = pace(turn * 3 + 1);
    snapshot.world.clock += 1;
  }
  out.faces = faces.size;
  return out;
}

/** A walk back and forth across the room, so proximity bands really change. */
function pace(step: number): number {
  const span = ROOM - 1;
  const wrapped = step % (span * 2);
  return wrapped <= span ? wrapped : span * 2 - wrapped;
}

describe('ambient locality', () => {
  it('keeps the rate of visible life flat as the world grows', () => {
    const baseline = measure(SIZES[0]!).seen;
    for (const size of SIZES) {
      const { seen } = measure(size);
      expect(seen, `${size.label}: ${seen}/${TURNS} against ${baseline}/${TURNS}`).toBe(baseline);
    }
  });

  it('is the fix: without it the same worlds go quieter', () => {
    // The control, and the reason the test above is not vacuous.
    //
    // Two things are worth reading off it. The first is that thirty maps are no worse than one
    // wide one: `ambientCast` has always refused to look at another map, so the cross-map half of
    // ALE-45 was already paid for by ALE-41 and the remaining leak is *within* a map — which only
    // became a leak when M4 made maps big enough for "on the player's map" to stop meaning "near
    // the player". The second is that the fall is a fifth rather than the wipe-out the arithmetic
    // ("one turn shared among thirty") suggests, and the reason is `Salience`: a neighbour whose
    // proximity band just changed outranks a stranger's idle drum, so the ranking was already
    // protecting most of the scene. What it does not protect is `Unmet` and `Idle`, and those are
    // the turns a wide district takes. The vicinity filter closes that gap without touching the
    // ranking, which is why it is a filter on *who is asked* and not a new sort key.
    const baseline = measure(SIZES[0]!, WHOLE_MAP).seen;
    expect(baseline).toBe(TURNS);
    for (const size of SIZES.slice(1)) {
      const { seen } = measure(size, WHOLE_MAP);
      expect(seen, `${size.label}: ${seen}/${TURNS}`).toBeLessThan(baseline * 0.8);
    }
  });

  it('spends almost every turn it costs on somebody the player is with', () => {
    for (const size of SIZES) {
      const { acted, seen } = measure(size);
      expect(seen / Math.max(1, acted), size.label).toBeGreaterThan(0.95);
    }
  });

  it('still shows a changing cast rather than the same neighbour every turn', () => {
    // A cheap way to hold the rate would be to pick the nearest person every time, which is a
    // world with one inhabitant. `Salience` is what stops that (ALE-41) and it has to keep working
    // inside the vicinity filter rather than being replaced by it.
    for (const size of SIZES) {
      expect(measure(size).faces, size.label).toBe(size.near);
    }
  });

  it('lets somebody out of vicinity back in when the player comes near', () => {
    // Distance defers a reaction; it never deletes a person. An NPC out of vicinity keeps the
    // reading it last acted on, so the first turn the player walks into range it is a candidate
    // again — exactly as one crowded out by `MAX_AMBIENT_ACTORS` is.
    const snapshot = world(SIZES[1]!);
    const far = snapshot.entities['npc:far:0']!;
    expect(distanceToPlayer(snapshot, far.id, PLAYER)).toBeGreaterThan(AMBIENT_VICINITY_FT);

    // Everybody has already acted once, so nothing is riding on `Salience.Unmet`.
    const acted = new Map<EntityId, AmbientSense>(
      Object.values(snapshot.entities)
        .filter((e) => e.components.brain?.policy === 'gm')
        .map((e) => [e.id, senseOf(snapshot, e.id, PLAYER)] as const),
    );
    const asked = (): EntityId[] =>
      ambientCandidates(snapshot, acted, { max: Infinity }).map((c) => c.entity);
    expect(asked()).not.toContain(far.id);

    const there = far.components.position!;
    Object.assign(snapshot.entities[PLAYER]!.components.position!, { x: there.x, y: there.y });
    expect(asked()).toContain(far.id);
  });

  it('never looks at somebody on another map', () => {
    const snapshot = world(SIZES[3]!);
    const everyone = ambientCandidates(snapshot, new Map(), { max: Infinity });
    expect(everyone.length).toBeGreaterThan(0);
    for (const candidate of everyone) {
      expect(snapshot.entities[candidate.entity]!.components.position!.map).toBe(HOME);
    }
  });
});
