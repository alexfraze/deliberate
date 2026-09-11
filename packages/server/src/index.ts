import { resolve } from 'node:path';

import { buildApp } from './app.js';
import { NARRATE_BUDGET_MS, PREVIEW_BUDGET_MS, RESOLVE_BUDGET_MS } from './gm/loop.js';
import { httpGmService } from './gm/service.js';

const port = Number(process.env['PORT'] ?? 8787);
const host = process.env['HOST'] ?? '127.0.0.1';

// Where sessions are recorded. Set RECORDINGS_DIR to an empty string to record nothing. pnpm runs
// scripts with the package as the cwd, so a relative directory is resolved against INIT_CWD — the
// repo root when someone types `pnpm dev:server` there — the way the replay CLI does it.
const dir = process.env['RECORDINGS_DIR'] ?? 'recordings';
const recordings = dir ? resolve(process.env['INIT_CWD'] ?? process.cwd(), dir) : null;

// Which world to boot. The M1 gatehouse by default; the acceptance suite (ALE-13) asks for the
// M0 fixture, which it plays by UI alone and replays hash-for-hash.
const scene = process.env['DELIBERATE_SCENE'] === 'fixture' ? 'fixture' : 'gatehouse';

// The Python game master (docs/gm-service.md). Unset means no model in the loop: preview shows
// the engine's own resolution and GO commits it, which is what a machine with no credentials gets.
const gmUrl = process.env['GM_SERVICE_URL'] ?? null;

// Phase ceilings. The blueprint's targets (preview 8 s, resolve 6 s, narrate 3 s) are the defaults
// in `gm/loop.ts`, and a real claude-opus-5 turn does not fit them today — so they are tunable
// here rather than only in a test, and the HTTP client is given a timeout no shorter than the
// longest of them, or it would be the thing that aborts the turn.
const ms = (name: string, fallback: number): number =>
  Number(process.env[name] ?? fallback) || fallback;
const budgets = {
  preview: ms('GM_PREVIEW_BUDGET_MS', PREVIEW_BUDGET_MS),
  resolve: ms('GM_RESOLVE_BUDGET_MS', RESOLVE_BUDGET_MS),
  narrate: ms('GM_NARRATE_BUDGET_MS', NARRATE_BUDGET_MS),
};

const app = await buildApp({
  logger: true,
  recordings,
  scene,
  budgets,
  gm: gmUrl
    ? httpGmService({ baseUrl: gmUrl, timeoutMs: Math.max(...Object.values(budgets)) })
    : null,
});
if (gmUrl) app.log.info({ gm: gmUrl }, 'game master service');
if (app.recording) app.log.info({ file: app.recording.path }, 'recording this session');
await app.listen({ port, host });
