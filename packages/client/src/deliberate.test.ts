import { describe, expect, it } from 'vitest';

import type { Diff } from '@deliberate/protocol';

import {
  canGo,
  describeEncounter,
  describeGm,
  describeMode,
  describeStaged,
  describeTurnSource,
  initialState,
  telegraph,
  NO_GM,
  type GmAvailability,
} from './deliberate.js';

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

describe('saying who ran the turn (ALE-39)', () => {
  const live: GmAvailability = {
    server: true,
    configured: true,
    reachable: true,
    model: 'claude-opus-5',
    narrateModel: 'claude-sonnet-5',
  };
  const none: GmAvailability = { ...NO_GM, server: true };

  it('says in words that deliberate mode off means no game master', () => {
    expect(describeMode(false, live)).toBe('engine only — the game master is not consulted');
    expect(describeMode(true, live)).toContain('the game master previews every click');
  });

  it('does not promise a game master that is absent or silent', () => {
    expect(describeMode(true, { ...live, reachable: false })).toContain(
      'the game master is not answering',
    );
    expect(describeMode(true, none)).toContain('no game master is configured');
    expect(describeMode(true, null)).not.toContain('game master previews');
  });

  it('names the models, and names the narration tier only when it differs', () => {
    expect(describeGm(live)).toBe('game master: claude-opus-5 · narration claude-sonnet-5');
    expect(describeGm({ ...live, narrateModel: 'claude-opus-5' })).toBe(
      'game master: claude-opus-5',
    );
    expect(describeGm(none)).toContain('GM_SERVICE_URL is unset');
    expect(describeGm(NO_GM)).toContain('offline fixture');
    expect(describeGm(null)).toContain('asking the server');
  });

  it('never claims the game master ran a turn it was not asked about', () => {
    expect(describeTurnSource('engine', live)).toContain('the game master was never asked');
    expect(describeTurnSource('previewed', live)).toContain('the game master previewed it');
    expect(describeTurnSource('previewed', none)).toContain('no game master was asked');
    expect(describeTurnSource('committed', live)).toBe('this turn: the game master ran it');
    expect(describeTurnSource('committed', none)).toContain('no game master was asked');
    expect(describeTurnSource('none', live)).toContain('nothing taken yet');
  });

  it('signposts that initiative only exists inside an encounter', () => {
    expect(describeEncounter(false)).toContain('End turn has nothing to end');
    expect(describeEncounter(true)).toContain('hands initiative to the NPCs');
  });

  it('names the verb that does work outside an encounter (ALE-41)', () => {
    // The old line ended "…and the world does not act", which was true and is the bug ALE-41
    // fixed. Out of combat there is now something to press, and the panel says which.
    expect(describeEncounter(false)).toContain('Wait lets time pass and the world act');
    expect(describeStaged({ kind: 'pass_time', entity: 'player' }, () => 'Halric')).toBe(
      'Halric waits, and the world gets a turn',
    );
  });
});
