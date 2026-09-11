import { resolve } from 'node:path';

import { buildApp } from './app.js';
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

const app = await buildApp({
  logger: true,
  recordings,
  scene,
  gm: gmUrl ? httpGmService({ baseUrl: gmUrl }) : null,
});
if (gmUrl) app.log.info({ gm: gmUrl }, 'game master service');
if (app.recording) app.log.info({ file: app.recording.path }, 'recording this session');
await app.listen({ port, host });
