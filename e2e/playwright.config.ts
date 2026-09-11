import { defineConfig, devices } from '@playwright/test';

import { CLIENT_PORT, RECORDINGS_DIR, REPO_ROOT, SERVER_PORT } from './paths.js';

/**
 * The M0 acceptance run (ALE-13): a real Chromium against the real client, the real server and the
 * real engine, with no model in the loop. Playwright starts both halves; the suite joins, plays,
 * is refused, and then replays the JSONL the server wrote.
 *
 * Not part of `pnpm check` — it needs a browser. Run it with `pnpm e2e`.
 */

const CLIENT_URL = `http://127.0.0.1:${CLIENT_PORT}`;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  reporter: [['list']],
  use: { baseURL: CLIENT_URL, ...devices['Desktop Chrome'] },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @deliberate/server start',
      cwd: REPO_ROOT,
      // The M0 training yard, not the M1 gatehouse: this suite plays it by UI alone and replays
      // the recording hash-for-hash, and its refusals and damage rolls are fixed by FIXTURE_SEED.
      env: {
        PORT: String(SERVER_PORT),
        HOST: '127.0.0.1',
        RECORDINGS_DIR,
        DELIBERATE_SCENE: 'fixture',
      },
      url: `${SERVER_URL}/healthz`,
      // Always a fresh engine and a fresh recording: the suite asserts on both.
      reuseExistingServer: false,
      stdout: 'ignore',
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @deliberate/client exec vite --host 127.0.0.1 --port ${CLIENT_PORT} --strictPort`,
      cwd: REPO_ROOT,
      env: { SERVER_ORIGIN: SERVER_URL },
      url: CLIENT_URL,
      reuseExistingServer: false,
      stdout: 'ignore',
      timeout: 60_000,
    },
  ],
});
