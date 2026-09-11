/**
 * Renderer creation: three.js `WebGPURenderer` with a WebGL fallback.
 *
 * `WebGPURenderer` drives either backend, so the fallback is a flag rather than a second code
 * path: if `navigator.gpu` is missing we ask for WebGL up front, and if WebGPU adapter
 * initialisation fails anyway (a browser that exposes `navigator.gpu` but has no working adapter)
 * we retry once with WebGL instead of leaving a blank page.
 */
import { WebGPURenderer } from 'three/webgpu';

export type RendererBackend = 'webgpu' | 'webgl';

export interface RendererHandle {
  renderer: WebGPURenderer;
  backend: RendererBackend;
}

function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/**
 * Which backend three actually ended up on. `init()` does not throw when `navigator.gpu` exists
 * but no adapter does — three logs and swaps to WebGL2 itself — so ask the backend rather than
 * trusting what we requested.
 */
function reportedBackend(renderer: WebGPURenderer, requested: RendererBackend): RendererBackend {
  const backend = renderer.backend as unknown as
    { isWebGPUBackend?: boolean; isWebGLBackend?: boolean } | undefined;
  if (backend?.isWebGPUBackend === true) return 'webgpu';
  if (backend?.isWebGLBackend === true) return 'webgl';
  return requested;
}

async function build(forceWebGL: boolean): Promise<RendererHandle> {
  const renderer = new WebGPURenderer({ antialias: true, forceWebGL });
  await renderer.init();
  return { renderer, backend: reportedBackend(renderer, forceWebGL ? 'webgl' : 'webgpu') };
}

export async function createRenderer(): Promise<RendererHandle> {
  const wantsWebGPU = webgpuAvailable();
  try {
    return await build(!wantsWebGPU);
  } catch (error) {
    if (!wantsWebGPU) throw error;
    console.warn('WebGPU initialisation failed, falling back to WebGL', error);
    return await build(true);
  }
}
