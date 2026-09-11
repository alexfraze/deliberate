import { HASH_EXCLUDED_COMPONENTS, type Snapshot } from '@deliberate/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createStore, fixtureSnapshot, FIXTURE_PLAYER_ID, storeFromJSON } from '../store/index.js';
import { canonicalize, hashableSnapshot, hashSnapshot } from './hash.js';

describe('canonicalize', () => {
  it('sorts keys recursively and drops undefined members', () => {
    expect(canonicalize({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalize([undefined, null, 'x'])).toBe('[null,null,"x"]');
    expect(canonicalize(-0)).toBe('0');
  });

  it('is independent of key insertion order for arbitrary JSON', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const shuffled = JSON.parse(JSON.stringify(v));
        expect(canonicalize(reorder(shuffled))).toBe(canonicalize(v));
      }),
      { seed: 8 },
    );
  });

  it('refuses values JSON cannot carry', () => {
    expect(() => canonicalize(NaN)).toThrow(TypeError);
    expect(() => canonicalize(() => 1)).toThrow(TypeError);
  });
});

/** Rebuild objects with keys in reverse order, recursively. */
function reorder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reorder);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).reverse()) out[k] = reorder((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

describe('hashSnapshot', () => {
  it('is a 128-hex-char blake2b-512 digest', () => {
    expect(hashSnapshot(fixtureSnapshot())).toMatch(/^[0-9a-f]{128}$/);
  });

  it('is stable across JSON serialisation and key reordering', () => {
    const snap = fixtureSnapshot();
    const h = hashSnapshot(snap);
    expect(hashSnapshot(JSON.parse(JSON.stringify(snap)))).toBe(h);
    expect(hashSnapshot(reorder(snap) as Snapshot)).toBe(h);
    expect(hashSnapshot(storeFromJSON(createStore(snap).toJSON()).snapshot())).toBe(h);
  });

  it('ignores cosmetic components and only those', () => {
    expect(HASH_EXCLUDED_COMPONENTS).toEqual(['dialogue', 'portrait']);
    const base = fixtureSnapshot();
    const h = hashSnapshot(base);

    const store = createStore(base);
    store.setComponent(FIXTURE_PLAYER_ID, 'portrait', { asset: 'portraits/other.png' });
    store.setComponent(FIXTURE_PLAYER_ID, 'dialogue', { seeds: ['hello', 'there'] });
    store.removeComponent('dummy-a', 'portrait');
    expect(hashSnapshot(store.snapshot())).toBe(h);

    store.setComponent(FIXTURE_PLAYER_ID, 'health', { hp: 11, maxHp: 12, conditions: [] });
    expect(hashSnapshot(store.snapshot())).not.toBe(h);
  });

  it('changes when a position, flag, clock, map cell, or initiative changes', () => {
    const base = fixtureSnapshot();
    const h = hashSnapshot(base);
    const variants: ((s: Snapshot) => void)[] = [
      (s) => {
        s.entities[FIXTURE_PLAYER_ID]!.components.position!.x += 1;
      },
      (s) => {
        s.world.flags['tutorial'] = false;
      },
      (s) => {
        s.world.clock += 1;
      },
      (s) => {
        s.world.maps['m0-yard']!.cells[13]!.walkable = false;
      },
      (s) => {
        s.initiative = { order: [FIXTURE_PLAYER_ID], current: 0, round: 1 };
      },
      (s) => {
        s.world.quests['first-blood']!.step = 1;
      },
      (s) => {
        s.entities[FIXTURE_PLAYER_ID]!.name = 'Someone else';
      },
    ];
    const seen = new Set<string>([h]);
    for (const mutate of variants) {
      const s = fixtureSnapshot();
      mutate(s);
      const hv = hashSnapshot(s);
      expect(hv).not.toBe(h);
      expect(seen.has(hv)).toBe(false);
      seen.add(hv);
    }
  });

  it('hashableSnapshot does not mutate its input', () => {
    const snap = fixtureSnapshot();
    const before = JSON.stringify(snap);
    const stripped = hashableSnapshot(snap);
    expect(JSON.stringify(snap)).toBe(before);
    expect(stripped.entities[FIXTURE_PLAYER_ID]!.components.portrait).toBeUndefined();
    expect(stripped.entities[FIXTURE_PLAYER_ID]!.components.health).toBeDefined();
  });

  it('pins the fixture hash so a silent canonicalisation change fails CI', () => {
    expect(hashSnapshot(fixtureSnapshot()).slice(0, 16)).toMatchInlineSnapshot(
      `"b8999e3caae8903f"`,
    );
  });
});
