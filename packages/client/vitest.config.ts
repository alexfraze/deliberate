import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'client',
    include: ['src/**/*.test.ts'],
    // Renderer code needs a browser; keep unit tests on pure modules (grid math, animation queue)
    // and put anything that touches three.js behind `environment: 'jsdom'` or a Playwright e2e.
    environment: 'node',
  },
});
