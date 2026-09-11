import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'npcs',
    include: ['src/**/*.test.ts'],
  },
});
