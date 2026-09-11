import type { Seed } from '@deliberate/protocol';

/** Deterministic pseudo-random source. Same seed, same call sequence, same numbers — on every platform. */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** A dN roll: integer in [1, sides]. */
  roll(sides: number): number;
}

/** FNV-1a 32-bit hash so string seeds map to a 32-bit state. */
function hashSeed(seed: Seed): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32: small, fast, and good enough for dice. Not cryptographic. Chosen because it is
 * trivially reproducible in Python for the M1 LLM service if that ever needs to mirror a roll.
 */
export function createRng(seed: Seed): Rng {
  let state = hashSeed(seed);
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new RangeError(`int(${min}, ${max}): need integers with max >= min`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },
    roll(sides) {
      return this.int(1, sides);
    },
  };
}
