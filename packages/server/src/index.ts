import { resolve } from 'node:path';

import { buildApp } from './app.js';
import { DEFAULT_CACHE_SIZE } from './gm/cache.js';
import {
  MAX_SPECULATIONS_PER_TURN,
  NARRATE_BUDGET_MS,
  PREVIEW_BUDGET_MS,
  RESOLVE_BUDGET_MS,
} from './gm/loop.js';
import { httpGmService } from './gm/service.js';
import { loadSave } from './save.js';

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

// Save slot (ALE-23). SAVES_DIR is where `POST /save` writes `<room>.json`; set it to an empty
// string to turn saving off. DELIBERATE_LOAD names a save to resume instead of booting a scene:
// the file is read here, before the app exists, because `buildApp` does no I/O.
const savesDir = process.env['SAVES_DIR'] ?? 'saves';
const saves = savesDir ? resolve(process.env['INIT_CWD'] ?? process.cwd(), savesDir) : null;
const loadPath = process.env['DELIBERATE_LOAD'] ?? null;
const load = loadSave(
  loadPath ? resolve(process.env['INIT_CWD'] ?? process.cwd(), loadPath) : null,
);

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

// Preview and NPC-decision cache (ALE-22). Keyed by state hash, so it invalidates itself; set
// GM_CACHE_SIZE=0 to turn it off and measure the cold path.
const cacheSize = Number(process.env['GM_CACHE_SIZE'] ?? DEFAULT_CACHE_SIZE);

// Speculative preview warming (ALE-40) — the kill switch, because this is the one feature that can
// spend money on an action nobody took. `GM_SPECULATE=0` (or `off`) disables it; any other number
// is the per-turn ceiling. The default is deliberately small: see `MAX_SPECULATIONS_PER_TURN`.
const speculateEnv = process.env['GM_SPECULATE'];
const speculationsPerTurn =
  speculateEnv === undefined || speculateEnv === ''
    ? MAX_SPECULATIONS_PER_TURN
    : speculateEnv === 'off'
      ? 0
      : Number(speculateEnv) || 0;

const app = await buildApp({
  logger: true,
  recordings,
  saves,
  load,
  scene,
  budgets,
  ...(Number.isFinite(cacheSize) ? { cacheSize } : {}),
  speculationsPerTurn,
  gm: gmUrl
    ? httpGmService({ baseUrl: gmUrl, timeoutMs: Math.max(...Object.values(budgets)) })
    : null,
});
if (gmUrl) app.log.info({ gm: gmUrl }, 'game master service');
app.log.info(
  { perTurn: speculationsPerTurn },
  speculationsPerTurn > 0 ? 'speculative preview warming is on' : 'speculative warming is off',
);
if (app.recording) app.log.info({ file: app.recording.path }, 'recording this session');
if (load) app.log.info({ turn: load.turn, hash: load.hash }, 'resumed a save');
if (app.save) app.log.info({ file: app.save.path }, 'POST /save writes here');
await app.listen({ port, host });
