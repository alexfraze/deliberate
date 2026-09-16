/**
 * Diff-driven animation queue.
 *
 * `DiffsMessage`s arrive in turn order and each carries several diffs; the renderer must play
 * them one at a time, in order, with the next one starting only after the previous has finished.
 * The queue owns that ordering and nothing else: it has no three.js in it and emits plain events
 * that the scene turns into meshes moving. Time is handed in as milliseconds so tests can step it
 * deterministically.
 */
import type {
  ConditionSet,
  DamageApplied,
  Diff,
  EntityId,
  EntityMoved,
  Tile,
} from '@deliberate/protocol';

/** Milliseconds spent per tile stepped through by `EntityMoved`. */
export const MS_PER_TILE = 180;

/** How long a `DamageApplied` flash and its floating number last. */
export const DAMAGE_MS = 650;

/**
 * The attacker's lunge, prepended to a `DamageApplied` that names a source.
 *
 * There is no attack diff in the protocol and there should not be one: an attack that connects
 * *is* damage, and the engine emits exactly what changed. So the swing is a phase of the damage
 * animation rather than an animation of its own — which also means it cannot overlap the hit it
 * causes, because there is only ever one animation in flight.
 */
export const LUNGE_MS = 220;

/** A `dead`/`unconscious` condition: the capsule folds up over this long. */
export const DEATH_MS = 520;

/** Diffs with nothing to show still occupy a beat so the HUD can keep up. */
export const INSTANT_MS = 0;

/** Conditions that mean an entity has gone down and should be animated doing so. */
const DEATH_CONDITIONS = new Set(['dead', 'dying', 'unconscious']);

export interface MoveAnimation {
  kind: 'move';
  diff: EntityMoved;
  /** `from` followed by the diff's path, so t=0 is where the entity is standing. */
  waypoints: Tile[];
  durationMs: number;
}

export interface DamageAnimation {
  kind: 'damage';
  diff: DamageApplied;
  /**
   * Who swung, when the blow came from somebody. Null for damage with no attacker — poison, a
   * fall, a trap — which skips the lunge and lands immediately.
   */
  attacker: EntityId | null;
  /** How much of `durationMs` the lunge occupies. 0 when there is no attacker. */
  lungeMs: number;
  durationMs: number;
}

/** An entity going down: `ConditionSet` turning `dead` (or `unconscious`) on. */
export interface DeathAnimation {
  kind: 'death';
  diff: ConditionSet;
  durationMs: number;
}

export interface InstantAnimation {
  kind: 'instant';
  diff: Diff;
  durationMs: number;
}

export type Animation = MoveAnimation | DamageAnimation | DeathAnimation | InstantAnimation;

export type QueueEvent =
  | { type: 'start'; animation: Animation }
  | { type: 'progress'; animation: Animation; t: number }
  | { type: 'finish'; animation: Animation };

function sameTile(a: Tile, b: Tile): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Turns one diff into the animation that plays it. Every diff gets one, so ordering is total. */
export function animationFor(diff: Diff): Animation {
  if (diff.type === 'EntityMoved') {
    const path = diff.path.length > 0 ? diff.path : [diff.to];
    const first = path[0];
    const waypoints = first && sameTile(first, diff.from) ? [...path] : [diff.from, ...path];
    return {
      kind: 'move',
      diff,
      waypoints,
      durationMs: Math.max(1, (waypoints.length - 1) * MS_PER_TILE),
    };
  }
  if (diff.type === 'DamageApplied') {
    const attacker = diff.source !== null && diff.source !== diff.target ? diff.source : null;
    const lungeMs = attacker === null ? 0 : LUNGE_MS;
    return { kind: 'damage', diff, attacker, lungeMs, durationMs: lungeMs + DAMAGE_MS };
  }
  if (diff.type === 'ConditionSet' && diff.active && DEATH_CONDITIONS.has(diff.condition)) {
    return { kind: 'death', diff, durationMs: DEATH_MS };
  }
  return { kind: 'instant', diff, durationMs: INSTANT_MS };
}

/**
 * The two halves of a strike at normalised time `t`: how far the attacker has lunged toward its
 * target (out and back, peaking as the blow lands) and how hard the target is flashing.
 *
 * Split out as a pure function because it is the part with arithmetic in it, and because both
 * halves must agree on where the boundary is — the flash has to start exactly when the lunge
 * tops out, or the hit reads as unrelated to the swing.
 */
export function strikePhase(animation: DamageAnimation, t: number): { lunge: number; hit: number } {
  const clamped = Math.min(1, Math.max(0, t));
  const boundary = animation.durationMs > 0 ? animation.lungeMs / animation.durationMs : 0;
  if (boundary <= 0) return { lunge: 0, hit: Math.sin(clamped * Math.PI) };
  if (clamped < boundary) return { lunge: clamped / boundary, hit: 0 };
  // After impact the attacker recovers over the first part of the flash, so the two overlap the
  // way a real swing does rather than the lunge snapping back before the target reacts.
  const after = (clamped - boundary) / (1 - boundary);
  return { lunge: Math.max(0, 1 - after * 2.5), hit: Math.sin(after * Math.PI) };
}

/** How far a dying capsule has folded up at normalised time `t`. Eased, so it settles. */
export function collapseAmount(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) * (1 - clamped);
}

/**
 * Position along a move animation at normalised time `t`, in fractional tile coordinates.
 * Constant speed per tile; `t` is clamped to [0, 1].
 */
export function samplePath(waypoints: readonly Tile[], t: number): { x: number; y: number } {
  const first = waypoints[0] ?? { x: 0, y: 0 };
  if (waypoints.length < 2) return { x: first.x, y: first.y };
  const clamped = Math.min(1, Math.max(0, t));
  const legs = waypoints.length - 1;
  const scaled = clamped * legs;
  const index = Math.min(legs - 1, Math.floor(scaled));
  const local = scaled - index;
  const a = waypoints[index] ?? first;
  const b = waypoints[index + 1] ?? a;
  return { x: a.x + (b.x - a.x) * local, y: a.y + (b.y - a.y) * local };
}

export class AnimationQueue {
  private readonly queue: Animation[] = [];
  private active: Animation | null = null;
  private elapsedMs = 0;

  /** Appends diffs in the order the server sent them. */
  enqueue(diffs: readonly Diff[]): void {
    for (const diff of diffs) this.queue.push(animationFor(diff));
  }

  get pending(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  get idle(): boolean {
    return this.pending === 0;
  }

  get current(): Animation | null {
    return this.active;
  }

  /**
   * Advances by `dtMs` and returns the events that happened, in order. Leftover time spills into
   * the next animation so a slow frame never drops one, but an animation always emits `start`
   * before any `progress` and exactly one `finish` before its successor starts.
   */
  advance(dtMs: number): QueueEvent[] {
    const events: QueueEvent[] = [];
    let remaining = Math.max(0, dtMs);
    for (;;) {
      if (!this.active) {
        const next = this.queue.shift();
        if (!next) return events;
        this.active = next;
        this.elapsedMs = 0;
        events.push({ type: 'start', animation: next });
      }
      const animation = this.active;
      const left = animation.durationMs - this.elapsedMs;
      if (remaining >= left) {
        remaining -= left;
        this.elapsedMs = animation.durationMs;
        events.push({ type: 'progress', animation, t: 1 });
        events.push({ type: 'finish', animation });
        this.active = null;
        this.elapsedMs = 0;
        continue;
      }
      this.elapsedMs += remaining;
      events.push({ type: 'progress', animation, t: this.elapsedMs / animation.durationMs });
      return events;
    }
  }

  clear(): void {
    this.queue.length = 0;
    this.active = null;
    this.elapsedMs = 0;
  }
}
