import { defineConfig } from 'vite';

// The game server (packages/server) listens on 8787 by default. The acceptance suite starts its
// own server on another port and points the client at it with SERVER_ORIGIN.
const origin = process.env['SERVER_ORIGIN'] ?? 'http://127.0.0.1:8787';

export default defineConfig({
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
