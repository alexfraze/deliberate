import type { MapRecord } from '@deliberate/protocol';
import { describe, expect, it } from 'vitest';

import { DEFAULT_ABILITY, exitAt, resolvePick } from './selection.js';

describe('resolvePick', () => {
  it('selects an entity when nothing is selected', () => {
    const result = resolvePick(null, { kind: 'entity', id: 'player', tile: { x: 2, y: 2 } });
    expect(result).toMatchObject({ selected: 'player', intent: null });
  });

  it('turns entity + tile into a move intent', () => {
    const result = resolvePick('player', { kind: 'tile', tile: { x: 5, y: 4 } });
    expect(result.selected).toBe('player');
    expect(result.intent).toEqual({ kind: 'move', entity: 'player', to: { x: 5, y: 4 } });
  });

  it('turns entity + another entity into an attack intent and keeps the attacker selected', () => {
    const result = resolvePick('player', { kind: 'entity', id: 'dummy-a', tile: { x: 3, y: 3 } });
    expect(result.selected).toBe('player');
    expect(result.intent).toEqual({
      kind: 'attack',
      attacker: 'player',
      target: 'dummy-a',
      ability: DEFAULT_ABILITY,
    });
  });

  it('deselects when the selected entity is clicked again', () => {
    const result = resolvePick('player', { kind: 'entity', id: 'player', tile: { x: 2, y: 2 } });
    expect(result).toMatchObject({ selected: null, intent: null });
  });

  it('does nothing useful when a tile is clicked with nothing selected', () => {
    const result = resolvePick(null, { kind: 'tile', tile: { x: 1, y: 1 } });
    expect(result.selected).toBeNull();
    expect(result.intent).toBeNull();
    expect(result.hint).toMatch(/select an entity/i);
  });

  it('clears the selection when the click misses everything', () => {
    expect(resolvePick('player', { kind: 'none' })).toMatchObject({ selected: null, intent: null });
    expect(resolvePick(null, { kind: 'none' })).toMatchObject({ selected: null, hint: null });
  });

  it('never copies the clicked tile by reference', () => {
    const tile = { x: 5, y: 4 };
    const result = resolvePick('player', { kind: 'tile', tile });
    tile.x = 99;
    expect(result.intent).toMatchObject({ to: { x: 5, y: 4 } });
  });
});

/**
 * ALE-43. Clicking the tile you are already standing on used to be the one click that could only
 * ever be refused ("is already there"). On an exit it is the click that takes the door, which is
 * why a doorway needs no button of its own.
 */
describe('resolvePick on an exit', () => {
  const lane: MapRecord = {
    id: 'yard',
    width: 3,
    height: 3,
    cells: Array.from({ length: 9 }, () => ({ elevation: 0, walkable: true })),
    exits: [{ at: { x: 1, y: 1 }, to: 'lane', entrance: { x: 0, y: 0 }, label: 'the postern' }],
  };

  it('turns a click on the exit under your feet into a traverse', () => {
    const result = resolvePick(
      'player',
      { kind: 'tile', tile: { x: 1, y: 1 } },
      { at: { x: 1, y: 1 }, map: lane },
    );
    expect(result.selected).toBe('player');
    expect(result.intent).toEqual({ kind: 'traverse', entity: 'player', to: 'lane' });
    expect(result.hint).toMatch(/the postern/);
  });

  it('is still a move when the exit is somewhere else, and when there is no exit at all', () => {
    expect(
      resolvePick(
        'player',
        { kind: 'tile', tile: { x: 1, y: 1 } },
        { at: { x: 2, y: 2 }, map: lane },
      ).intent,
    ).toEqual({ kind: 'move', entity: 'player', to: { x: 1, y: 1 } });
    expect(
      resolvePick(
        'player',
        { kind: 'tile', tile: { x: 2, y: 2 } },
        { at: { x: 2, y: 2 }, map: lane },
      ).intent,
    ).toEqual({ kind: 'move', entity: 'player', to: { x: 2, y: 2 } });
  });

  it('behaves exactly as it always did with no world handed in', () => {
    expect(resolvePick('player', { kind: 'tile', tile: { x: 1, y: 1 } }).intent).toEqual({
      kind: 'move',
      entity: 'player',
      to: { x: 1, y: 1 },
    });
  });

  it('finds the exit standing on a tile, and nothing anywhere else', () => {
    expect(exitAt(lane, { x: 1, y: 1 })?.to).toBe('lane');
    expect(exitAt(lane, { x: 0, y: 1 })).toBeNull();
    expect(exitAt(null, { x: 1, y: 1 })).toBeNull();
  });
});

/**
 * Found by playing (ALE-43): a click on the square you are standing on lands on your capsule, not
 * on the floor, so the traverse has to be reachable from the entity branch as well as the tile
 * one. Before this it deselected the player and the door could not be opened at all.
 */
describe('clicking your own capsule on an exit', () => {
  const yard: MapRecord = {
    id: 'yard',
    width: 3,
    height: 3,
    cells: Array.from({ length: 9 }, () => ({ elevation: 0, walkable: true })),
    exits: [{ at: { x: 1, y: 1 }, to: 'lane', entrance: { x: 0, y: 0 }, label: 'the postern' }],
  };
  const world = { at: { x: 1, y: 1 }, map: yard };

  it('takes the door instead of deselecting', () => {
    const result = resolvePick(
      'player',
      { kind: 'entity', id: 'player', tile: { x: 1, y: 1 } },
      world,
    );
    expect(result.intent).toEqual({ kind: 'traverse', entity: 'player', to: 'lane' });
    expect(result.selected).toBe('player');
  });

  it('still deselects when there is no door under you', () => {
    const result = resolvePick(
      'player',
      { kind: 'entity', id: 'player', tile: { x: 2, y: 2 } },
      { at: { x: 2, y: 2 }, map: yard },
    );
    expect(result).toMatchObject({ selected: null, intent: null });
  });

  it('still attacks somebody else standing on an exit', () => {
    const result = resolvePick(
      'player',
      { kind: 'entity', id: 'dummy-a', tile: { x: 1, y: 1 } },
      { at: { x: 2, y: 2 }, map: yard },
    );
    expect(result.intent).toMatchObject({ kind: 'attack', target: 'dummy-a' });
  });
});
