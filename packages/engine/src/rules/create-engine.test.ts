import type { Intent, Snapshot } from '@deliberate/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { hashSnapshot } from '../hash/index.js';
import { fixtureSnapshot, FIXTURE_PLAYER_ID, FIXTURE_SEED } from '../store/index.js';
import { createEngine } from './create-engine.js';

const boot = (snapshot: Snapshot = fixtureSnapshot()) =>
  createEngine(snapshot, { seed: FIXTURE_SEED });

describe('createEngine', () => {
  it('reports the snapshot and its hash without aliasing', () => {
    const initial = fixtureSnapshot();
    const engine = boot(initial);
    expect(engine.snapshot()).toEqual(initial);
    expect(engine.hash()).toBe(hashSnapshot(initial));
    const snap = engine.snapshot();
    snap.world.clock = 5;
    expect(engine.snapshot().world.clock).toBe(0);
  });

  it('moves a living entity along a path within its speed and emits EntityMoved', () => {
    const engine = boot();
    const before = engine.hash();
    const verdict = engine.apply({ kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x: 6, y: 4 } });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.diff).toHaveLength(1);
    const d = verdict.diff[0]!;
    expect(d.type).toBe('EntityMoved');
    if (d.type !== 'EntityMoved') return;
    expect(d.from).toEqual({ x: 2, y: 2 });
    expect(d.to).toEqual({ x: 6, y: 4 });
    expect(d.path.at(-1)).toEqual({ x: 6, y: 4 });
    expect(d.path.length).toBeLessThanOrEqual(6);
    const pos = engine.snapshot().entities[FIXTURE_PLAYER_ID]!.components.position!;
    expect(pos).toMatchObject({ x: 6, y: 4 });
    expect(engine.hash()).not.toBe(before);
  });

  it.each<[string, Intent, RegExp]>([
    ['unknown entity', { kind: 'move', entity: 'nobody', to: { x: 1, y: 1 } }, /no one called/],
    ['off map', { kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x: 40, y: 1 } }, /off the map/],
    ['wall', { kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x: 0, y: 0 } }, /cannot be walked/],
    ['occupied', { kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x: 8, y: 3 } }, /occupied/],
    ['same tile', { kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x: 2, y: 2 } }, /already there/],
    [
      'too far',
      { kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x: 10, y: 10 } },
      /can move 30 ft/,
    ],
    [
      'attack',
      { kind: 'attack', attacker: FIXTURE_PLAYER_ID, target: 'dummy-a', ability: 'longsword' },
      /not available/,
    ],
    ['end turn', { kind: 'end_turn', entity: FIXTURE_PLAYER_ID }, /not available/],
  ])('rejects %s with a readable reason and changes nothing', (_label, intent, reason) => {
    const engine = boot();
    const before = engine.hash();
    const snapBefore = engine.snapshot();
    const verdict = engine.apply(intent);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(reason);
    expect(verdict.diff).toEqual([]);
    expect(engine.hash()).toBe(before);
    expect(engine.snapshot()).toEqual(snapBefore);
  });

  it('rejects moves by downed entities and entities without a position', () => {
    const snap = fixtureSnapshot();
    snap.entities[FIXTURE_PLAYER_ID]!.components.health!.hp = 0;
    const downed = boot(snap).apply({
      kind: 'move',
      entity: FIXTURE_PLAYER_ID,
      to: { x: 3, y: 2 },
    });
    expect(downed).toMatchObject({ ok: false, reason: expect.stringMatching(/down/) });

    const snap2 = fixtureSnapshot();
    delete snap2.entities[FIXTURE_PLAYER_ID]!.components.position;
    const nowhere = boot(snap2).apply({
      kind: 'move',
      entity: FIXTURE_PLAYER_ID,
      to: { x: 3, y: 2 },
    });
    expect(nowhere).toMatchObject({ ok: false, reason: expect.stringMatching(/not on the map/) });
  });

  it('routes around other entities and walls; reports unreachable tiles', () => {
    const engine = boot();
    // (1,7) is south of the middle wall; the gap is at (5,6) and (10,6). Too far in one move.
    const far = engine.apply({ kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x: 1, y: 7 } });
    expect(far).toMatchObject({ ok: false, reason: expect.stringMatching(/ft away/) });
    // The raised platform's 2-elevation column is reachable only via the 1-elevation ramp.
    const platformSnap = fixtureSnapshot();
    platformSnap.entities[FIXTURE_PLAYER_ID]!.components.position!.x = 7;
    platformSnap.entities[FIXTURE_PLAYER_ID]!.components.position!.y = 5;
    const e2 = boot(platformSnap);
    const up = e2.apply({ kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x: 10, y: 3 } });
    expect(up.ok).toBe(true);
  });

  it('replays deterministically: same seed and intents give the same hashes', () => {
    const intents: Intent[] = [
      { kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x: 5, y: 5 } },
      { kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x: 0, y: 0 } },
      { kind: 'move', entity: 'dummy-a', to: { x: 8, y: 1 } },
      { kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x: 5, y: 7 } },
    ];
    const run = () => {
      const engine = boot();
      return intents.map((i) => [engine.apply(i).ok, engine.hash()]);
    };
    expect(run()).toEqual(run());
  });

  it('property: a rejected move never changes the hash; an accepted one lands on target', () => {
    const tile = fc.record({
      x: fc.integer({ min: -1, max: 12 }),
      y: fc.integer({ min: -1, max: 12 }),
    });
    const entity = fc.constantFrom(FIXTURE_PLAYER_ID, 'dummy-a', 'dummy-b', 'ghost');
    fc.assert(
      fc.property(fc.array(fc.record({ entity, to: tile }), { maxLength: 12 }), (moves) => {
        const engine = boot();
        for (const m of moves) {
          const before = engine.hash();
          const v = engine.apply({ kind: 'move', entity: m.entity, to: m.to });
          if (v.ok) {
            const pos = engine.snapshot().entities[m.entity]!.components.position!;
            expect({ x: pos.x, y: pos.y }).toEqual(m.to);
            expect(engine.hash()).not.toBe(before);
          } else {
            expect(v.reason.length).toBeGreaterThan(0);
            expect(engine.hash()).toBe(before);
          }
        }
        // No two entities ever share a tile.
        const tiles = Object.values(engine.snapshot().entities).map((e) => {
          const p = e.components.position!;
          return `${p.x},${p.y}`;
        });
        expect(new Set(tiles).size).toBe(tiles.length);
      }),
      { seed: 8, numRuns: 150 },
    );
  });
});
