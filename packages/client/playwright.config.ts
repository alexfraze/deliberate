import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke test only, and deliberately NOT part of `pnpm check`: it needs a Chromium download that
 * CI runners do not have. Run it locally with `pnpm --filter @deliberate/client smoke` once
 * Playwright's browsers are cached. The full end-to-end suite (client + server + recorder) is
 * ALE-13's job.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5178',
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec vite --port 5178 --strictPort',
    url: 'http://localhost:5178',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    timeout: 60_000,
  },
});
