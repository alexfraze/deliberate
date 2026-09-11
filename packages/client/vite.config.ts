import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // The game server (packages/server) listens on 8787; the client talks to it over /ws.
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
      '/healthz': { target: 'http://127.0.0.1:8787' },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
