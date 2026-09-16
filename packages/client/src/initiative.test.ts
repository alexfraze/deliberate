import type { InitiativeState } from '@deliberate/protocol';
import { describe, expect, it } from 'vitest';

import { describeEconomy, healthFraction, initiativeView, nextUp } from './initiative.js';
import { emptyView, type ViewEntity, type ViewState } from './view.js';

function entity(id: string, hp: number, conditions: string[] = []): ViewEntity {
  return {
    id,
    name: id === 'player' ? 'Player' : `NPC ${id}`,
    faction: id === 'player' ? 'party' : 'vermin',
    tile: { x: 0, y: 0 },
    hp,
    maxHp: 10,
    conditions,
  };
}

function viewWith(initiative: InitiativeState | null, ...entities: ViewEntity[]): ViewState {
  const view = emptyView();
  view.initiative = initiative;
  for (const e of entities) view.entities[e.id] = e;
  return view;
}

const order = ['player', 'a', 'b'];

describe('initiativeView', () => {
  it('has nothing to show outside an encounter', () => {
    expect(initiativeView(emptyView())).toBeNull();
    expect(initiativeView(viewWith({ order: [], current: 0, round: 1 }))).toBeNull();
  });

  it('keeps the engine’s order and moves the highlight, rather than rotating the strip', () => {
    const entities = [entity('player', 10), entity('a', 10), entity('b', 10)];
    const first = initiativeView(viewWith({ order, current: 0, round: 1 }, ...entities));
    const second = initiativeView(viewWith({ order, current: 1, round: 1 }, ...entities));
    expect(first?.chips.map((c) => c.id)).toEqual(order);
    expect(second?.chips.map((c) => c.id)).toEqual(order);
    expect(first?.chips.map((c) => c.current)).toEqual([true, false, false]);
    expect(second?.chips.map((c) => c.current)).toEqual([false, true, false]);
  });

  it('marks who is up next, skipping anyone who is down', () => {
    const view = viewWith(
      { order, current: 0, round: 2 },
      entity('player', 10),
      entity('a', 0),
      entity('b', 7),
    );
    const chips = initiativeView(view)?.chips ?? [];
    expect(chips.map((c) => c.next)).toEqual([false, false, true]);
    expect(chips[1]?.down).toBe(true);
    expect(initiativeView(view)?.round).toBe(2);
  });

  it('counts a dead or unconscious entity as down even with hp left on the clock', () => {
    const view = viewWith(
      { order, current: 0, round: 1 },
      entity('player', 10),
      entity('a', 4, ['unconscious']),
      entity('b', 4, ['prone']),
    );
    const chips = initiativeView(view)?.chips ?? [];
    expect(chips[1]?.down).toBe(true);
    expect(chips[2]?.down).toBe(false);
    // Prone is not down, so it is the one up next.
    expect(chips.map((c) => c.next)).toEqual([false, false, true]);
  });

  it('names an entity it has never seen by its id rather than dropping it from the order', () => {
    const chips = initiativeView(viewWith({ order, current: 0, round: 1 }))?.chips ?? [];
    expect(chips.map((c) => c.name)).toEqual(['player', 'a', 'b']);
    expect(chips.every((c) => c.down)).toBe(true);
  });

  it('shows what is left to spend on the acting chip only', () => {
    const chips =
      initiativeView(
        viewWith(
          {
            order,
            current: 1,
            round: 1,
            turn: { movedFt: 15, actionUsed: true, bonusActionUsed: false },
          },
          entity('player', 10),
          entity('a', 10),
          entity('b', 10),
        ),
      )?.chips ?? [];
    expect(chips[1]?.economy).toBe('bonus · 15 ft');
    expect(chips[0]?.economy).toBeNull();
    expect(chips[2]?.economy).toBeNull();
  });
});

describe('nextUp', () => {
  it('wraps past the end of the order', () => {
    expect(nextUp({ order, current: 2, round: 1 }, () => false)).toBe(0);
  });

  it('gives up rather than pointing at the current entity when nobody else is standing', () => {
    expect(nextUp({ order, current: 0, round: 1 }, (id) => id !== 'player')).toBe(-1);
    expect(nextUp({ order: ['solo'], current: 0, round: 1 }, () => false)).toBe(-1);
  });
});

describe('describeEconomy', () => {
  it('lists what is left, not what was spent', () => {
    expect(describeEconomy({ order, current: 0, round: 1 })).toBe('action · bonus');
    expect(
      describeEconomy({
        order,
        current: 0,
        round: 1,
        turn: { movedFt: 0, actionUsed: false, bonusActionUsed: false },
      }),
    ).toBe('action · bonus');
    expect(
      describeEconomy({
        order,
        current: 0,
        round: 1,
        turn: { movedFt: 30, actionUsed: true, bonusActionUsed: true },
      }),
    ).toBe('30 ft');
    expect(
      describeEconomy({
        order,
        current: 0,
        round: 1,
        turn: { movedFt: 0, actionUsed: true, bonusActionUsed: true },
      }),
    ).toBe('spent');
  });
});

describe('healthFraction', () => {
  it('clamps, so a stray number cannot invert or overflow the bar', () => {
    const chip = {
      id: 'a',
      name: 'a',
      faction: 'vermin',
      hp: 5,
      maxHp: 10,
      current: false,
      next: false,
      down: false,
      economy: null,
    };
    expect(healthFraction(chip)).toBe(0.5);
    expect(healthFraction({ ...chip, hp: -3 })).toBe(0);
    expect(healthFraction({ ...chip, hp: 40 })).toBe(1);
  });
});
