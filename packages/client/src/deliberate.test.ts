import { describe, expect, it } from 'vitest';

import type { Diff } from '@deliberate/protocol';

import { canGo, describeStaged, initialState, telegraph } from './deliberate.js';

const NAMES: Record<string, string> = { player: 'Player', guard: 'Halloran' };
const nameOf = (id: string): string => NAMES[id] ?? id;

describe('deliberate state', () => {
  it('starts off, and GO does nothing until a preview has come back', () => {
    expect(initialState()).toEqual({ phase: 'off' });
    expect(canGo(initialState(true))).toBe(false);
    expect(canGo({ phase: 'thinking', intent: null })).toBe(false);
    expect(canGo({ phase: 'previewed', intent: null, text: '', diffs: [] })).toBe(true);
    expect(canGo({ phase: 'committing' })).toBe(false);
  });

  it('describes what GO would commit', () => {
    expect(describeStaged(null, nameOf)).toContain('nothing staged');
    expect(describeStaged({ kind: 'move', entity: 'player', to: { x: 3, y: 4 } }, nameOf)).toBe(
      'Player → (3, 4)',
    );
    expect(
      describeStaged(
        { kind: 'attack', attacker: 'player', target: 'guard', ability: 'longsword' },
        nameOf,
      ),
    ).toBe('Player attacks Halloran with longsword');
  });
});

describe('telegraphed reactions', () => {
  it('turns the preview diffs into one line each, and drops turn bookkeeping', () => {
    const diffs: Diff[] = [
      { type: 'EntityMoved', entity: 'player', from: { x: 2, y: 9 }, to: { x: 2, y: 8 }, path: [] },
      {
        type: 'EconomySpent',
        entity: 'player',
        turn: { movedFt: 5, actionUsed: false, bonusActionUsed: false },
      },
      { type: 'DialogueLine', speaker: 'guard', text: 'Far enough.', to: null },
      { type: 'DispositionChanged', entity: 'guard', toward: 'player', value: -5, reason: 'armed' },
      { type: 'DamageApplied', target: 'player', amount: 4, source: 'guard', hpAfter: 8 },
    ];
    expect(telegraph(diffs, nameOf)).toEqual([
      'Player moves to (2, 8).',
      'Halloran: “Far enough.”',
      'Halloran feels -5 toward Player — armed.',
      'Player takes 4 damage (8 hp left).',
    ]);
  });

  it('names an entity it has never seen by its id rather than dropping the line', () => {
    const diffs: Diff[] = [{ type: 'DialogueLine', speaker: 'npc:ghost', text: 'oh', to: null }];
    expect(telegraph(diffs, nameOf)).toEqual(['npc:ghost: “oh”']);
  });
});
