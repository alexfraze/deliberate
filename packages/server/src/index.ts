import { buildApp } from './app.js';

const port = Number(process.env['PORT'] ?? 8787);
const host = process.env['HOST'] ?? '127.0.0.1';
// Where sessions are recorded. Set RECORDINGS_DIR to an empty string to record nothing.
const recordings = process.env['RECORDINGS_DIR'] ?? 'recordings';

const app = await buildApp({ logger: true, recordings: recordings || null });
if (app.recording) app.log.info({ file: app.recording.path }, 'recording this session');
await app.listen({ port, host });
