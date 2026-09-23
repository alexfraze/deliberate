import { canonicalize, distanceFeet, isIncapacitated } from '@deliberate/engine';
import type { EntityId, Snapshot, Tile } from '@deliberate/protocol';

import { stanceOf, type Stance } from './cache.js';

/**
 * The ambient world turn (ALE-41) — **who acts when nobody is fighting, and why**.
 *
 * Outside an encounter there is no initiative, so `gmActor` is `null` and `resolve()` has nobody
 * to ask. A player who never drew a sword therefore never saw an NPC do anything: the guard stood
 * on the gate forever, the merchant never spoke unbidden, the wounded scout bled in silence. This
 * module is the answer to "whose turn is it when it is nobody's turn".
 *
 * Three rules shape it, and all three are about *not* being a random number generator:
 *
 * 1. **An NPC acts because something it could perceive changed.** Every ambient-capable NPC has a
 *    `AmbientSense` — how close the player is, how it feels about them, where the quests stand,
 *    and how long it has been since anything happened. An NPC acts when that reading differs from
 *    the last one it acted on. An NPC whose world has not moved does not move either, which is
 *    the whole difference between a living world and a twitching one.
 * 2. **The cause is nameable.** `describeChange` turns the difference between two readings into a
 *    sentence, and that sentence rides on the prompt, so the game master is told *what the NPC
 *    noticed* rather than left to invent a reason. An NPC that acts for no reason is worse than
 *    an NPC standing still.
 * 3. **One acts per turn, and it is somebody the player is with.** Ambient turns are frequent, so
 *    the bound on how many NPCs may act is the bound on what a quiet minute costs. Whoever the
 *    change is most about goes first — see `Salience` — and distance only breaks the tie. Because
 *    there is only one turn to give, who is *eligible* for it decides whether the world reads as
 *    alive: an NPC acting across a two-hundred-foot district is a turn the player never sees, so
 *    the cast is the player's map and their vicinity — see `AMBIENT_VICINITY_FT` (ALE-45).
 *
 * Nothing here mutates anything or knows what an NPC will do. It reads a snapshot and returns a
 * list of ids with reasons; `loop.ts` takes the turns, through the same `/gm/tool` door and the
 * same engine validation as every other NPC turn.
 */

/** The GM's own brain policy. `content/npcs` stamps it on all three archetypes (ALE-16). */
export const GM_BRAIN_POLICY = 'gm';

/**
 * How near the player has to be for an NPC to count them as present, in feet. Thirty is one
 * move — the distance the player can close in a single turn — so "near" means "could be on me
 * next turn", which is the threshold a guard on a gate actually cares about.
 */
export const AMBIENT_NOTICE_FT = 30;

/** Within reach: close enough to speak to without raising a voice. One tile. */
export const AMBIENT_ADJACENT_FT = 5;

/**
 * How far from the player an NPC may be and still be asked to act, in feet (ALE-45).
 *
 * The player's *map* was always the outer bound — `ambientCast` has never looked at another one —
 * and for one small gatehouse that was the same thing as "nearby". M4 makes it a different thing.
 * An authored district is two hundred feet across, so "on the player's map" stops meaning "where
 * the player is", and the one ambient turn a quiet minute buys starts going to people on the far
 * side of it. That is the worst of both: the turn is paid for and the player never learns it
 * happened, so a world with more people in it *reads as emptier* than the world it replaced. It
 * is the exact way this milestone could make the game worse while every test still passed.
 *
 * A hundred and twenty feet is four moves — far enough that somebody the player is walking
 * towards is stirring before they arrive, and near enough that what they do lands in the same
 * scene. Beyond it nobody is cancelled: an NPC out of vicinity keeps the reading it last acted
 * on, so the first turn the player comes within range it is a candidate again, exactly as an NPC
 * crowded out by `MAX_AMBIENT_ACTORS` is. Distance defers a reaction here; it never deletes a
 * person.
 *
 * This is a bound on *who is asked*, not on who exists and not on who may be narrated. The map
 * still holds everyone, `get_state` still reports them, and an NPC the player walks up to is the
 * most salient candidate there is.
 */
export const AMBIENT_VICINITY_FT = 120;

/**
 * Rounds of the world clock that count as one "nothing has happened" beat.
 *
 * Without this, a player who stands perfectly still and waits sees a perfectly still world, which
 * is defensible but makes `pass_time` a verb with no consequence. Time passing *is* something the
 * player can perceive — they pressed the button — so it earns a place in the reading, coarsely
 * enough that it is a slow drum rather than a tick.
 */
export const AMBIENT_IDLE_ROUNDS = 3;

/**
 * NPCs allowed to act in one ambient turn.
 *
 * This is the cost ceiling, and it is the reason an ambient turn is not a combat turn. In a fight
 * every living combatant takes a turn because the rules say so; out of one, the world does **one
 * thing at a time**. One is not a placeholder for a bigger number: an ambient turn's whole claim
 * is that it costs a fraction of a combat turn, and the honest way to hold that is to bound the
 * NPC turns at one rather than to hope they are cheap. Two NPCs both wanting the model on one
 * quiet turn is a combat turn's bill for a moment in which nothing happened.
 *
 * It also reads better. A guard glancing up *and* a merchant calling out *and* a scout groaning,
 * all in the same beat, is a cutscene; one of them is a place. The others are not cancelled — an
 * NPC crowded out keeps its old reading and is first in line next turn.
 */
export const MAX_AMBIENT_ACTORS = 1;

/** Proximity bands. Coarse on purpose: shuffling a tile is not news, crossing a band is. */
export type Proximity = 'beside' | 'near' | 'away';

/**
 * What one NPC can currently tell about the world, in the four dimensions it is allowed to react
 * to. Deliberately coarse: it is the *key* that decides whether to spend a turn, so anything fine
 * enough to change every time the player takes a step would make every turn an acting turn.
 */
export interface AmbientSense {
  proximity: Proximity;
  /** How this NPC feels about the player, in the bands `content/npcs` gates its dialogue on. */
  stance: Stance;
  /** Where every quest stands. A quest step moving is a thing an NPC in the story would hear. */
  quests: string;
  /** Which "nothing has happened" beat the clock is in. See `AMBIENT_IDLE_ROUNDS`. */
  idle: number;
}

export interface AmbientCandidate {
  entity: EntityId;
  sense: AmbientSense;
  /** Feet to the player. The tie-break, once salience has spoken. */
  distanceFt: number;
  /** How urgent the change is. The sort key; see `Salience`. */
  salience: Salience;
  /** What changed, in a sentence. Rides on the prompt so the model is told what the NPC noticed. */
  reason: string;
}

export interface AmbientOptions {
  noticeFt?: number;
  idleRounds?: number;
  max?: number;
  /** See `AMBIENT_VICINITY_FT`. `Infinity` restores the whole-map behaviour of ALE-41. */
  vicinityFt?: number;
}

export function proximityOf(distanceFt: number, noticeFt: number): Proximity {
  if (distanceFt <= AMBIENT_ADJACENT_FT) return 'beside';
  if (distanceFt <= noticeFt) return 'near';
  return 'away';
}

/** The player character, or `null` when the scene has none — in which case nothing is ambient. */
export function playerOf(snapshot: Snapshot): EntityId | null {
  for (const entity of Object.values(snapshot.entities)) {
    if (entity.components.brain?.policy === 'player') return entity.id;
  }
  return null;
}

/**
 * Everyone the game master plays who is in a fit state to do something *and near enough to be
 * worth asking*: alive, conscious, on the player's map, within `AMBIENT_VICINITY_FT`, and with a
 * position to act from.
 *
 * Both filters are the same economy. A corpse is skipped here rather than refused later, because
 * a model call that was always going to be rejected is money spent on a foregone answer; and
 * somebody across the district is skipped for the same reason one step on, because a model call
 * the player never perceives is money spent on an answer nobody hears (ALE-45).
 */
function ambientCast(
  snapshot: Snapshot,
  player: EntityId,
  playerMap: string,
  vicinityFt: number,
): EntityId[] {
  return Object.values(snapshot.entities)
    .filter((entity) => {
      if (entity.components.brain?.policy !== GM_BRAIN_POLICY) return false;
      const position = entity.components.position;
      if (!position || position.map !== playerMap) return false;
      if (distanceToPlayer(snapshot, entity.id, player) > vicinityFt) return false;
      return !isIncapacitated(entity.components.health);
    })
    .map((entity) => entity.id)
    .sort();
}

/** What `npc` can tell about the world right now. Pure read; the same snapshot always answers the
 * same way, which is what makes "has anything changed?" a question with an answer. */
export function senseOf(
  snapshot: Snapshot,
  npc: EntityId,
  player: EntityId,
  options: AmbientOptions = {},
): AmbientSense {
  const noticeFt = options.noticeFt ?? AMBIENT_NOTICE_FT;
  const idleRounds = Math.max(1, options.idleRounds ?? AMBIENT_IDLE_ROUNDS);
  const here = snapshot.entities[npc]?.components.position;
  const there = snapshot.entities[player]?.components.position;
  const distanceFt = here && there ? distanceFeet(here as Tile, there as Tile) : Infinity;
  const toward = snapshot.entities[npc]?.components.disposition?.toward ?? {};
  return {
    proximity: proximityOf(distanceFt, noticeFt),
    stance: stanceOf(toward[player] ?? 0),
    quests: canonicalize(
      Object.values(snapshot.world.quests)
        .map((q) => [q.id, q.step] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    ),
    idle: Math.floor(snapshot.world.clock / idleRounds),
  };
}

/** Feet from `npc` to `player`, or `Infinity` if either is not standing anywhere. */
export function distanceToPlayer(snapshot: Snapshot, npc: EntityId, player: EntityId): number {
  const here = snapshot.entities[npc]?.components.position;
  const there = snapshot.entities[player]?.components.position;
  return here && there ? distanceFeet(here as Tile, there as Tile) : Infinity;
}

const PROXIMITY_REASON: Record<Proximity, string> = {
  beside: 'the player has come close enough to touch',
  near: 'the player has come within a move of them',
  away: 'the player has walked out of reach',
};

/**
 * What kind of change this is, lowest number first. Only one NPC acts per turn, so this is the
 * question of *which* one, and it is a question about the story rather than about the map.
 *
 * Distance is the tie-break and not the ranking, and that is the whole point of having a ranking
 * at all. Sorting on distance alone starves anyone standing across the yard: the merchant by the
 * player's elbow re-qualifies on the slow idle drum every few rounds and takes the turn from the
 * scout the player has just walked over to. Ranked, the person whose relationship with the player
 * *just changed* goes first and the idler waits, which is both fairer and better drama.
 */
export const enum Salience {
  /** The player moved relative to them. The most direct cause there is; they saw it happen. */
  Proximity = 0,
  /** Something the player did changed how this NPC feels about them. */
  Stance = 1,
  /** The story moved a step. Everyone with a stake in it has heard. */
  Quest = 2,
  /** They have not acted at all yet. The world introducing itself; once per NPC per session. */
  Unmet = 3,
  /** Nothing happened, for a while. The slow drum; always last, and never starves anyone else. */
  Idle = 4,
}

/**
 * The difference between two readings: how urgent it is, and what it was, as a sentence the game
 * master can act on. `null` means nothing changed, which means this NPC has nothing to react to
 * and must not be asked — an NPC acting for no reason is worse than an NPC standing still.
 */
export function describeChange(
  before: AmbientSense | undefined,
  now: AmbientSense,
): { salience: Salience; reason: string } | null {
  if (!before) {
    return {
      salience: Salience.Unmet,
      reason: 'they have not yet stirred since the player arrived',
    };
  }
  const notes: string[] = [];
  let salience = Salience.Idle;
  const note = (rank: Salience, text: string): void => {
    notes.push(text);
    salience = Math.min(salience, rank) as Salience;
  };
  if (before.proximity !== now.proximity) {
    note(Salience.Proximity, PROXIMITY_REASON[now.proximity]);
  }
  if (before.stance !== now.stance) {
    note(Salience.Stance, `how they feel about the player is now ${now.stance}`);
  }
  if (before.quests !== now.quests) note(Salience.Quest, 'a quest has moved a step');
  if (before.idle !== now.idle) note(Salience.Idle, 'time has passed and nothing has come of it');
  return notes.length > 0 ? { salience, reason: notes.join('; ') } : null;
}

/**
 * Who should act this ambient turn, most-provoked first, and why.
 *
 * `acted` is the reading each NPC last took a turn on — `loop.ts` owns it, because it is session
 * state and this module is a pure function of a snapshot. An NPC that was passed over keeps its
 * old reading and so stays a candidate next turn: being crowded out delays a reaction by a beat,
 * it does not cancel it.
 */
export function ambientCandidates(
  snapshot: Snapshot,
  acted: ReadonlyMap<EntityId, AmbientSense>,
  options: AmbientOptions = {},
): AmbientCandidate[] {
  // An encounter has its own answer to "whose turn is it", and it is initiative's, not this one's.
  if (snapshot.initiative) return [];
  const player = playerOf(snapshot);
  const playerMap = player ? snapshot.entities[player]?.components.position?.map : undefined;
  if (!player || !playerMap) return [];

  const out: AmbientCandidate[] = [];
  const vicinityFt = options.vicinityFt ?? AMBIENT_VICINITY_FT;
  for (const npc of ambientCast(snapshot, player, playerMap, vicinityFt)) {
    const sense = senseOf(snapshot, npc, player, options);
    const change = describeChange(acted.get(npc), sense);
    if (!change) continue;
    out.push({
      entity: npc,
      sense,
      distanceFt: distanceToPlayer(snapshot, npc, player),
      ...change,
    });
  }
  out.sort(
    (a, b) =>
      a.salience - b.salience || a.distanceFt - b.distanceFt || (a.entity < b.entity ? -1 : 1),
  );
  return out.slice(0, Math.max(0, options.max ?? MAX_AMBIENT_ACTORS));
}
