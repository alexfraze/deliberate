import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite';

// The game server (packages/server) listens on 8787 by default. The acceptance suite starts its
// own server on another port and points the client at it with SERVER_ORIGIN.
const origin = process.env['SERVER_ORIGIN'] ?? 'http://127.0.0.1:8787';

/**
 * Serves the replay bank at `/recordings/<name>.jsonl` in dev, so `?replay=yard-brawl` plays a
 * real recorded session through the real render path (ALE-19). Dev only — the built client talks
 * to a server — and read-only, with the name restricted to a bare file stem so nothing outside
 * `recordings/bank/` is reachable.
 */
function replayBank(): Plugin {
  const bank = fileURLToPath(new URL('../../recordings/bank/', import.meta.url));
  return {
    name: 'deliberate-replay-bank',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = /^\/recordings\/([\w-]+)\.jsonl$/.exec(request.url ?? '')?.[1];
        if (!name) return next();
        readFile(`${bank}${name}.jsonl`, 'utf8').then(
          (body) => {
            response.setHeader('content-type', 'application/x-ndjson');
            response.end(body);
          },
          () => {
            response.statusCode = 404;
            response.end('no such recording');
          },
        );
      });
    },
  };
}

export default defineConfig({
  plugins: [replayBank()],
  server: {
    port: 5173,
    // The client talks to the game server over /ws; vite proxies it so both share an origin.
    proxy: {
      '/ws': { target: origin.replace(/^http/, 'ws'), ws: true },
      '/healthz': { target: origin },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
