import { describe, expect, it } from 'vitest';

import { createRng } from './rng.js';

describe('createRng', () => {
  it('is deterministic for the same seed', () => {
    const a = createRng('m0-seed');
    const b = createRng('m0-seed');
    const seqA = Array.from({ length: 50 }, () => a.roll(20));
    const seqB = Array.from({ length: 50 }, () => b.roll(20));
    expect(seqA).toEqual(seqB);
  });

  it('diverges for different seeds', () => {
    const a = createRng('one');
    const b = createRng('two');
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('keeps rolls inside [1, sides]', () => {
    const rng = createRng('bounds');
    for (let i = 0; i < 2000; i++) {
      const r = rng.roll(6);
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(6);
      expect(Number.isInteger(r)).toBe(true);
    }
  });

  it('pins the first values so a silent algorithm change fails CI (replay depends on this)', () => {
    const rng = createRng('pinned');
    expect([rng.roll(20), rng.roll(20), rng.roll(20)]).toMatchInlineSnapshot(`
      [
        19,
        15,
        20,
      ]
    `);
  });
});
