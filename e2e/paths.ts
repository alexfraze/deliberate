import { fileURLToPath } from 'node:url';

/** Repo root, resolved from this file so every path works whatever the cwd. */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Where the acceptance run's server writes its JSONL recording. Gitignored; wiped per run. */
export const RECORDINGS_DIR = fileURLToPath(new URL('.recordings', import.meta.url));

/** The replay CLI, built by `pnpm --filter @deliberate/engine build`. */
export const REPLAY_CLI = fileURLToPath(
  new URL('../packages/engine/dist/recorder/cli.js', import.meta.url),
);

export const SERVER_PORT = 8788;
export const CLIENT_PORT = 5179;
