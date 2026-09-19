/**
 * Post-processing (ALE-34): a colour grade, and nothing else.
 *
 * The issue's original sketch said "SSAO + bloom + colour grade". SSAO and bloom are atmospheric
 * tools — they add dirt in the creases and haze around the bright bits, which is how you sell a
 * *photographed* room. This scene is not one. The art direction is graphic: flat high-chroma tiles,
 * a hard shadow, crisp edges. Ambient occlusion would smear grey into the exact corners the hard
 * shadow is there to state, and bloom would bleed the rim light back across the silhouette it just
 * finished separating. Both would cost frames to make the frame less readable.
 *
 * So the pass does the three things a graphic look actually wants:
 *
 * - **Contrast**, around linear middle grey. Pushes the floor down and the lit faces up, which is
 *   the "strong value contrast" of the direction, applied to the render rather than to the palette
 *   — so it holds no matter what a light is doing.
 * - **Saturation.** Lambert shading desaturates as it falls off; flat colour does not. Pulling
 *   chroma back up restores the poster read without needing the palette to be garish at source.
 * - **A vignette.** Half a stop at the corners. Not for atmosphere: an orthographic camera has no
 *   natural centre of attention, and this gives the board one.
 *
 * Every parameter comes from the theme, because the light theme needs *less* of all three — a pale
 * ground is already high-key, and the same push that makes the dark theme crisp makes the light one
 * chalky.
 *
 * If the node pipeline fails to build for any reason, `createGrade` returns a plain renderer call.
 * A missing grade is a slightly flatter picture; a throwing grade is a blank page.
 */
import { mix, pass, pow, saturation, screenUV, vec3 } from 'three/tsl';
import { NoToneMapping, RenderPipeline, type Scene, type WebGPURenderer } from 'three/webgpu';

import type { Palette, ThemeName } from './palette.js';
import type { OrthographicCamera } from 'three/webgpu';

interface GradeSettings {
  /** Exponent around middle grey. >1 is more contrast. */
  contrast: number;
  /** 1 leaves chroma alone. */
  saturation: number;
  /** How dark the corners go, 0..1. */
  vignette: number;
}

const SETTINGS: Readonly<Record<ThemeName, GradeSettings>> = {
  dark: { contrast: 1.22, saturation: 1.18, vignette: 0.26 },
  // A light ground is already at the top of the range: the same contrast push would clip the floor
  // to paper and the same vignette would read as a smudge on the screen.
  light: { contrast: 1.1, saturation: 1.1, vignette: 0.16 },
};

export interface Grade {
  /** Draw a frame. */
  render(): void;
  setPalette(palette: Palette): void;
  /** Whether the graded pipeline actually built. The HUD says so, so a flat frame is explicable. */
  readonly active: boolean;
}

/** Linear-light middle grey: the pivot a contrast curve has to rotate about to stay neutral. */
const MIDDLE_GREY = 0.18;

export function createGrade(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: OrthographicCamera,
  palette: Palette,
): Grade {
  // The grade owns the transfer function, so the renderer must not apply one of its own first.
  // Tone mapping is a photographic curve; rolling off highlights is precisely what flat colour is
  // not meant to do.
  renderer.toneMapping = NoToneMapping;

  const plain: Grade = {
    render: () => renderer.render(scene, camera),
    setPalette: () => {},
    active: false,
  };

  let post: RenderPipeline;
  try {
    post = new RenderPipeline(renderer);
    post.outputNode = graded(scene, camera, SETTINGS[palette.name]);
  } catch (error) {
    console.warn('colour grade unavailable, rendering ungraded', error);
    return plain;
  }

  let broken = false;
  return {
    render: () => {
      if (broken) {
        renderer.render(scene, camera);
        return;
      }
      try {
        post.render();
      } catch (error) {
        console.warn('colour grade failed mid-frame, falling back', error);
        broken = true;
        renderer.render(scene, camera);
      }
    },
    setPalette: (next) => {
      post.outputNode = graded(scene, camera, SETTINGS[next.name]);
      post.needsUpdate = true;
    },
    active: true,
  };
}

/** The whole grade as one node graph. Rebuilt, not re-parameterised, when the theme changes. */
function graded(scene: Scene, camera: OrthographicCamera, settings: GradeSettings) {
  // `pass` hands back linear-light colour, so the curve pivots on linear middle grey rather than
  // on 0.5 — pivoting on 0.5 would darken everything as a side effect of adding contrast.
  const contrasted = pow(
    pass(scene, camera).rgb.div(MIDDLE_GREY).max(0.0001),
    settings.contrast,
  ).mul(MIDDLE_GREY);
  // Radial falloff from the centre of the frame. The exponent keeps the middle two thirds
  // untouched and puts the whole drop in the corners.
  const corner = screenUV.sub(0.5).length().mul(1.42).clamp(0, 1).pow(2.2);
  return saturation(contrasted, settings.saturation).mul(
    mix(vec3(1), vec3(1 - settings.vignette), corner),
  );
}
