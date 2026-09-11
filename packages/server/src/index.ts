import { resolve } from 'node:path';

import { buildApp } from './app.js';

const port = Number(process.env['PORT'] ?? 8787);
const host = process.env['HOST'] ?? '127.0.0.1';

// Where sessions are recorded. Set RECORDINGS_DIR to an empty string to record nothing. pnpm runs
// scripts with the package as the cwd, so a relative directory is resolved against INIT_CWD — the
// repo root when someone types `pnpm dev:server` there — the way the replay CLI does it.
const dir = process.env['RECORDINGS_DIR'] ?? 'recordings';
const recordings = dir ? resolve(process.env['INIT_CWD'] ?? process.cwd(), dir) : null;

const app = await buildApp({ logger: true, recordings });
if (app.recording) app.log.info({ file: app.recording.path }, 'recording this session');
await app.listen({ port, host });
