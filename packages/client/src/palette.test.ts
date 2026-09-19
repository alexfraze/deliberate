import { describe, expect, it } from 'vitest';

import {
  ELEVATION_TOP,
  PALETTES,
  cssVariables,
  factionColor,
  hslToHex,
  mixHex,
  otherTheme,
  paletteFor,
  resolveTheme,
  tileColor,
  type Palette,
  type ThemeName,
} from './palette.js';

const THEMES: ThemeName[] = ['dark', 'light'];

/**
 * The smallest gap in L* that still reads as a deliberate difference in value rather than as a
 * rendering artefact. Roughly a tenth of the range, which is about where a flat fill stops looking
 * like the same paint under a slightly different light.
 */
const VALUE_STEP = 8;

/**
 * CIE L*, 0..100. "Strong value contrast" is a claim about what the eye sees, and linear
 * luminance is not that — the same hex step measures several times larger up at the light theme's
 * floor than down at the dark theme's, so a threshold written in luminance would silently mean
 * something different in each theme. L* is perceptually even, so one number means one thing in
 * both, which is the only way these assertions are worth writing down.
 */
function lightness(hex: string): number {
  const channel = (i: number): number => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const y = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return y <= 0.008856 ? 903.3 * y : 116 * Math.cbrt(y) - 16;
}

describe('resolveTheme', () => {
  it('follows the browser when nothing is asked for', () => {
    expect(resolveTheme('', '', true)).toBe('dark');
    expect(resolveTheme('', '', false)).toBe('light');
  });

  it('lets the query string pin a theme, which is how both get screenshotted', () => {
    expect(resolveTheme('?theme=light', '', true)).toBe('light');
    expect(resolveTheme('?theme=dark', '', false)).toBe('dark');
    expect(resolveTheme('', '#theme=light', true)).toBe('light');
  });

  it('ignores a theme it has never heard of rather than drawing nothing', () => {
    expect(resolveTheme('?theme=sepia', '', true)).toBe('dark');
  });

  it('round-trips through otherTheme', () => {
    for (const theme of THEMES) expect(otherTheme(otherTheme(theme))).toBe(theme);
  });
});

describe('hslToHex', () => {
  it('matches the CSS primaries', () => {
    expect(hslToHex(0, 1, 0.5)).toBe('#ff0000');
    expect(hslToHex(120, 1, 0.5)).toBe('#00ff00');
    expect(hslToHex(240, 1, 0.5)).toBe('#0000ff');
    expect(hslToHex(0, 0, 1)).toBe('#ffffff');
    expect(hslToHex(0, 0, 0)).toBe('#000000');
  });

  it('wraps the hue instead of going out of gamut', () => {
    expect(hslToHex(360, 1, 0.5)).toBe(hslToHex(0, 1, 0.5));
    expect(hslToHex(-120, 1, 0.5)).toBe(hslToHex(240, 1, 0.5));
  });
});

describe('mixHex', () => {
  it('returns the endpoints and clamps past them', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', -3)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 9)).toBe('#ffffff');
  });

  it('interpolates per channel', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});

describe('factionColor', () => {
  it('uses the palette for factions it knows, so a theme switch moves them', () => {
    expect(factionColor(PALETTES.dark, 'party')).toBe(PALETTES.dark.factions['party']);
    expect(factionColor(PALETTES.light, 'party')).toBe(PALETTES.light.factions['party']);
    expect(factionColor(PALETTES.dark, 'party')).not.toBe(factionColor(PALETTES.light, 'party'));
  });

  it('is deterministic for a faction it has never seen', () => {
    const once = factionColor(PALETTES.dark, 'cult-of-the-drowned-lamp');
    expect(factionColor(PALETTES.dark, 'cult-of-the-drowned-lamp')).toBe(once);
    expect(once).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('gives an unknown faction the theme’s own lightness, not a random value', () => {
    // The whole point of the fallback: a faction the palette has never heard of still has to be
    // separable from the ground, which is a statement about value and not about hue.
    const dark = lightness(factionColor(PALETTES.dark, 'unheard-of'));
    const light = lightness(factionColor(PALETTES.light, 'unheard-of'));
    expect(dark).toBeGreaterThan(lightness(PALETTES.dark.floor) + VALUE_STEP);
    expect(light).toBeLessThan(lightness(PALETTES.light.floor) - VALUE_STEP);
  });
});

describe('tileColor', () => {
  const floor = { walkable: true, elevation: 0 };

  it('draws unwalkable cells as the wall hue, flat', () => {
    for (const palette of Object.values(PALETTES)) {
      const wall = { walkable: false, elevation: 0 };
      expect(tileColor(palette, wall, { x: 0, y: 0 })).toBe(palette.wall);
      // Not a checkerboard and not lifted by elevation: a wall is one material.
      expect(tileColor(palette, { walkable: false, elevation: 2 }, { x: 1, y: 0 })).toBe(
        palette.wall,
      );
    }
  });

  it('alternates the floor on a checkerboard so the grid reads without lines', () => {
    for (const palette of Object.values(PALETTES)) {
      expect(tileColor(palette, floor, { x: 0, y: 0 })).toBe(palette.floor);
      expect(tileColor(palette, floor, { x: 1, y: 0 })).toBe(palette.floorAlt);
      expect(tileColor(palette, floor, { x: 1, y: 1 })).toBe(palette.floor);
    }
  });

  it('lifts toward floorHigh with elevation and stops there', () => {
    for (const palette of Object.values(PALETTES)) {
      const top = { walkable: true, elevation: ELEVATION_TOP };
      const tile = { x: 0, y: 0 };
      expect(tileColor(palette, top, tile)).toBe(palette.floorHigh);
      // Past the top of the ramp it clamps rather than running off into white.
      expect(tileColor(palette, { walkable: true, elevation: 99 }, tile)).toBe(palette.floorHigh);
      const mid = lightness(tileColor(palette, { walkable: true, elevation: 1 }, tile));
      expect(mid).toBeGreaterThan(lightness(palette.floor));
      expect(mid).toBeLessThan(lightness(palette.floorHigh));
    }
  });
});

describe('the palettes themselves', () => {
  /**
   * The direction is "strong value contrast". These are the pairs that carry the frame, and a
   * future palette edit that quietly flattens one of them is exactly the regression this file is
   * here to catch — a screenshot cannot be diffed, but a gap in L* can.
   */
  it.each(THEMES)('%s separates ground, structure and units by value', (name) => {
    const palette: Palette = paletteFor(name);
    const floor = lightness(palette.floor);
    // The two halves of the checkerboard are close: a value step, not a second colour. Too big a
    // step and the ground reads as a chessboard the game does not have.
    expect(Math.abs(floor - lightness(palette.floorAlt))).toBeLessThan(VALUE_STEP);
    // Walls have to read off the floor on value alone, with no help from hue or from the rim —
    // this is the pair the dark theme got wrong first time round, at 3 points of L*.
    expect(Math.abs(lightness(palette.wall) - floor)).toBeGreaterThan(VALUE_STEP);
    // Elevation is legible as brightness, before anyone reads a number off the HUD.
    expect(lightness(palette.floorHigh)).toBeGreaterThan(floor + 15);
    // Every faction is separable from the ground it stands on.
    for (const [faction, hex] of Object.entries(palette.factions)) {
      expect(Math.abs(lightness(hex) - floor), `${faction} on the ${name} floor`).toBeGreaterThan(
        15,
      );
    }
    // And HUD text has to survive over the backdrop behind it.
    expect(Math.abs(lightness(palette.text) - lightness(palette.surface))).toBeGreaterThan(60);
  });

  it.each(THEMES)('%s names every token, in the same shape', (name) => {
    const palette = paletteFor(name);
    expect(Object.keys(palette).sort()).toEqual(Object.keys(paletteFor(otherTheme(name))).sort());
    expect(Object.keys(palette.factions).sort()).toEqual(
      Object.keys(paletteFor(otherTheme(name)).factions).sort(),
    );
    expect(palette.name).toBe(name);
  });

  it.each(THEMES)('%s exports CSS variables for every overlay token', (name) => {
    const vars = cssVariables(paletteFor(name));
    for (const [key, value] of Object.entries(vars)) {
      expect(key.startsWith('--dl-'), key).toBe(true);
      expect(value.length, key).toBeGreaterThan(0);
    }
    // index.html reads these by name; dropping one silently unstyles part of the HUD.
    expect(Object.keys(vars)).toContain('--dl-surface');
    expect(Object.keys(vars)).toContain('--dl-text');
    expect(Object.keys(vars)).toContain('--dl-panel');
  });
});
