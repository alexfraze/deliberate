/**
 * The palette (ALE-34). **One place** where every colour in the client is named.
 *
 * The art direction is graphic / minimal — flat, high-chroma tiles, a limited set of hues, strong
 * value contrast, hard shadow, bold rim light. Closer to Into the Breach than to Baldur's Gate.
 * The reason is that there are no character models yet: realistic lighting on an untextured capsule
 * reads as *unfinished*, whereas a graphic direction makes the same capsule read as a deliberate
 * icon. So fidelity here comes from lighting and palette, not polycount.
 *
 * Six hues carry the whole scene:
 *
 * | hue     | carries                                              |
 * | ------- | ---------------------------------------------------- |
 * | teal    | the ground — floor tiles, and the bounce light off it |
 * | slate   | structure — backdrop, board, walls, UI chrome         |
 * | azure   | the party, and every informational accent             |
 * | amber   | attention — selection, hover, whose turn it is, kills |
 * | coral   | harm — damage numbers, refusals                       |
 * | violet  | the third faction                                     |
 *
 * Everything is a `#rrggbb` string so a single token can feed both a three.js `Color` and a CSS
 * custom property. That is the point of the file: the scene and the DOM overlay cannot drift
 * apart, and a theme is one object rather than a hunt through two languages.
 *
 * Pure on purpose — no three.js, no DOM — so it unit-tests under node, and so ALE-18's models and
 * ALE-35's portraits can import these tokens and be palette-locked to the game without pulling a
 * renderer in with them.
 */

/** Light or dark. The scene and the DOM overlay always agree; there is one theme, not two. */
export type ThemeName = 'dark' | 'light';

export interface Palette {
  readonly name: ThemeName;

  // --- the board -------------------------------------------------------------------------------
  /** Behind everything. The void the board sits in. */
  readonly surface: string;
  /** The plinth under the map: it turns a raft of floating tiles into a board with an edge. */
  readonly board: string;
  /** Walkable floor at elevation 0. */
  readonly floor: string;
  /** The other half of the checkerboard. A small value step, enough to read the grid without lines. */
  readonly floorAlt: string;
  /** What floor tiles lerp toward as elevation rises: higher is lighter. */
  readonly floorHigh: string;
  /** Unwalkable cells. Drawn proud of the floor, so these are blocks rather than holes. */
  readonly wall: string;

  // --- the lighting rig ------------------------------------------------------------------------
  /** Key light. Warm, hard, and the only thing casting a shadow. */
  readonly key: string;
  /** Hemisphere fill from above. Keeps shadowed faces coloured instead of black. */
  readonly sky: string;
  /** Hemisphere fill from below — the ground bouncing its own hue back up. */
  readonly bounce: string;
  /** Rim light, from behind and low. What separates a unit's silhouette from the floor. */
  readonly rim: string;

  // --- signals (unlit; lighting must never be able to dim these) -------------------------------
  readonly select: string;
  readonly hover: string;
  readonly marker: string;
  readonly damage: string;
  readonly kill: string;
  /** What a struck unit flashes toward. */
  readonly flash: string;

  // --- factions --------------------------------------------------------------------------------
  readonly factions: Readonly<Record<string, string>>;
  /** Saturation and lightness for a faction the palette has never heard of. */
  readonly factionFallback: { readonly s: number; readonly l: number };

  // --- the DOM overlay -------------------------------------------------------------------------
  readonly text: string;
  readonly textMuted: string;
  readonly textAccent: string;
  readonly textWarn: string;
  readonly panel: string;
  readonly panelEdge: string;
  readonly field: string;
  readonly fieldEdge: string;
  readonly button: string;
  readonly good: string;
  /** Drop shadow behind HUD text, so it survives over a bright floor as well as a dark one. */
  readonly textShadow: string;
}

/**
 * Dark. High-chroma teal ground, cool slate structure; units are bright so they sit on top of
 * the ground in value as well as hue.
 */
const DARK: Palette = {
  name: 'dark',
  surface: '#0b1117',
  board: '#16212c',
  floor: '#2f6d68',
  floorAlt: '#286059',
  floorHigh: '#84cba6',
  wall: '#66809f',

  key: '#fff1d9',
  sky: '#9dc4e8',
  bounce: '#2f6d68',
  rim: '#63e0ff',

  select: '#ffd166',
  hover: '#ffe9a8',
  marker: '#7fd4ff',
  damage: '#ff6b5a',
  kill: '#ffd166',
  flash: '#fff0e6',

  factions: {
    party: '#4cc2ff',
    garrison: '#ffa94d',
    traders: '#c08bff',
    dummies: '#d9b382',
    vermin: '#b8e04a',
  },
  factionFallback: { s: 0.62, l: 0.66 },

  text: '#e8eef4',
  textMuted: '#8496a8',
  textAccent: '#9fd0ff',
  textWarn: '#ffb86b',
  panel: 'rgba(11, 17, 23, 0.86)',
  panelEdge: '#22303d',
  field: '#0b1117',
  fieldEdge: '#36485a',
  button: '#c8d3dd',
  good: '#6fbf73',
  textShadow: '0 1px 2px rgba(0, 0, 0, 0.85)',
};

/**
 * Light. Not "dark with the brightness turned up": the ground rises in value, so the units have to
 * come *down* in value to keep the same separation. That inversion is the reason faction colours
 * are palette tokens rather than constants — it is the whole cost of supporting a second theme.
 */
const LIGHT: Palette = {
  name: 'light',
  surface: '#e9eff3',
  board: '#b9c8d2',
  floor: '#74bfae',
  floorAlt: '#66b3a2',
  floorHigh: '#d8ecca',
  wall: '#8091a6',

  key: '#fffaf0',
  sky: '#dceaf6',
  bounce: '#74bfae',
  rim: '#3f9fc8',

  select: '#d97706',
  hover: '#ffdf85',
  marker: '#0d6f9c',
  damage: '#c62f1c',
  kill: '#9a6100',
  flash: '#fff4ea',

  factions: {
    party: '#0f66c2',
    garrison: '#c2560b',
    traders: '#7b3fc4',
    dummies: '#8a6b3c',
    vermin: '#4f7a10',
  },
  factionFallback: { s: 0.68, l: 0.34 },

  text: '#16222c',
  textMuted: '#5a6b7a',
  textAccent: '#11557f',
  textWarn: '#a2560a',
  panel: 'rgba(249, 251, 252, 0.9)',
  panelEdge: '#b9c8d2',
  field: '#ffffff',
  fieldEdge: '#9fb1bf',
  button: '#2c3d4c',
  good: '#2f7a3c',
  textShadow: '0 1px 2px rgba(255, 255, 255, 0.75)',
};

export const PALETTES: Readonly<Record<ThemeName, Palette>> = { dark: DARK, light: LIGHT };

export function paletteFor(theme: ThemeName): Palette {
  return PALETTES[theme];
}

/**
 * Which theme to draw. `?theme=light` (or `#theme=light`) pins it — the acceptance shots need both
 * on demand — and otherwise the browser's own preference decides, so the page matches the desktop
 * it opened on rather than asserting a taste.
 */
export function resolveTheme(search: string, hash = '', prefersDark = true): ThemeName {
  const asked =
    new URLSearchParams(search).get('theme') ?? /theme=(\w+)/.exec(hash)?.[1] ?? undefined;
  if (asked === 'light' || asked === 'dark') return asked;
  return prefersDark ? 'dark' : 'light';
}

export function otherTheme(theme: ThemeName): ThemeName {
  return theme === 'dark' ? 'light' : 'dark';
}

/** `#rrggbb` from hue in degrees, saturation and lightness in 0..1. */
export function hslToHex(hueDegrees: number, s: number, l: number): string {
  const h = ((hueDegrees % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sextant = Math.floor(h / 60) % 6;
  const rgb = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][sextant] ?? [0, 0, 0];
  const byte = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v + m)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(rgb[0] ?? 0)}${byte(rgb[1] ?? 0)}${byte(rgb[2] ?? 0)}`;
}

/**
 * The colour of a faction. Named factions come from the palette so they are theme-aware; anything
 * the palette has never heard of gets a stable hue from its name at the theme's own saturation and
 * lightness, so an unknown faction is still separable from the ground rather than a random value.
 */
export function factionColor(palette: Palette, faction: string): string {
  const known = palette.factions[faction];
  if (known !== undefined) return known;
  let hash = 0;
  for (const ch of faction) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return hslToHex(hash, palette.factionFallback.s, palette.factionFallback.l);
}

/** Linear blend between two `#rrggbb` strings. `t` is clamped. */
export function mixHex(from: string, to: string, t: number): string {
  const k = Math.min(1, Math.max(0, t));
  const parse = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const a = parse(from);
  const b = parse(to);
  const byte = (i: number): string =>
    Math.round((a[i] ?? 0) + ((b[i] ?? 0) - (a[i] ?? 0)) * k)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(0)}${byte(1)}${byte(2)}`;
}

/** How many elevation steps it takes for a floor tile to reach `floorHigh`. */
export const ELEVATION_TOP = 3;

/**
 * The colour of one tile. Unwalkable is the wall hue flat; walkable lifts toward `floorHigh` with
 * elevation and alternates between two close values on a checkerboard — which is what lets you
 * count tiles across the map without drawing a single grid line.
 */
export function tileColor(
  palette: Palette,
  cell: { walkable: boolean; elevation: number },
  tile: { x: number; y: number },
): string {
  if (!cell.walkable) return palette.wall;
  const base = (tile.x + tile.y) % 2 === 0 ? palette.floor : palette.floorAlt;
  return mixHex(base, palette.floorHigh, Math.min(1, cell.elevation / ELEVATION_TOP));
}

/**
 * The palette as CSS custom properties, so `index.html` names the same tokens the scene does and a
 * theme switch is one assignment rather than a second stylesheet.
 */
export function cssVariables(palette: Palette): Readonly<Record<string, string>> {
  return {
    '--dl-surface': palette.surface,
    '--dl-board': palette.board,
    '--dl-text': palette.text,
    '--dl-text-muted': palette.textMuted,
    '--dl-accent': palette.textAccent,
    '--dl-warn': palette.textWarn,
    '--dl-panel': palette.panel,
    '--dl-panel-edge': palette.panelEdge,
    '--dl-field': palette.field,
    '--dl-field-edge': palette.fieldEdge,
    '--dl-button': palette.button,
    '--dl-select': palette.select,
    '--dl-good': palette.good,
    '--dl-damage': palette.damage,
    '--dl-kill': palette.kill,
    '--dl-text-shadow': palette.textShadow,
  };
}
