import { describe, expect, it } from 'vitest';

import { DEFAULT_ABILITY, resolvePick } from './selection.js';

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
