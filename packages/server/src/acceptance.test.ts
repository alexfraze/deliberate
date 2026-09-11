import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createEngine, formatSummary, parseRecording, replay, summarize } from '@deliberate/engine';
import { GATEHOUSE_SEED, GUARD_ID, MERCHANT_ID, gatehouseSnapshot } from '@deliberate/npcs';
import {
  PROTOCOL_VERSION,
  type EntityId,
  type Intent,
  type RecordedTurn,
  type RecordingHeader,
  type RecordingLine,
  type ServerMessage,
  type Snapshot,
} from '@deliberate/protocol';

import { buildApp } from './app.js';
import { GM_BRAIN_POLICY } from './gm/loop.js';
import { tokensFrom, usdFor } from './gm/meters.js';
import { httpGmService, type GmService, type GmTurnResponse } from './gm/service.js';

/**
 * M1 acceptance (ALE-17). The exit criterion for the milestone, in three claims, each of which is
 * checked **against the recording** rather than against the code that wrote it:
 *
 * 1. **Zero direct state edits.** Every hash in the recording chains: the header's hash is the
 *    first line's `hashBefore`, every line's `hashAfter` is the next line's `hashBefore`, and a
 *    fresh engine replaying nothing but the recorded intents arrives at the recorded final hash.
 *    A mutation that reached the store by any other road would break that chain, because the
 *    replay engine would never make it.
 * 2. **Every GM mutation carries an engine verdict.** Each line the game master caused carries the
 *    tool call that asked for it beside the `Verdict` the engine answered with — including the
 *    rejections, which must leave the hash where it was and carry a player-readable reason.
 * 3. **The recording replays to identical hashes.** `replay` is the CLI's own function.
 *
 * There are two suites. The first replays a **committed** recording of a real ten-turn playthrough
 * against the live model, so the acceptance evidence is re-checkable in CI with no credentials and
 * no Python. The second **regenerates** it: it boots the Python GM service against the real Claude
 * API and plays ten turns through the preview-then-GO loop. That one needs a key and money, so it
 * is skipped without `ANTHROPIC_API_KEY` — the required `check` job must never depend on a model.
 *
 *   source ~/.deliberate-env && pnpm --filter @deliberate/server test -- acceptance
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

/**
 * The committed evidence: the JSONL a real ten-turn playthrough against `claude-opus-5` wrote.
 *
 * Replaying it needs the engine and nothing else: no key, no model, no network. So one expensive
 * live run becomes a permanent free regression artifact, and anyone who later changes the rules,
 * the hash or the diff set gets an immediate failure showing they broke determinism against a real
 * model-driven session.
 *
 * It lives in `recordings/bank/`, which is committed (only `recordings/*.jsonl` is ignored),
 * because ALE-21 grew it into the regression bank: it is the first of six entries there and is
 * replayed with the rest by `pnpm bank` and `src/bank/bank.test.ts`. This suite keeps its own
 * assertions because they are about the milestone, not about determinism.
 */
const FIXTURE = resolve(repoRoot, 'recordings/bank/m1-acceptance.jsonl');

// ---------------------------------------------------------------------------------------------
// The assertions. One function, run against the committed recording and against a fresh one.
// ---------------------------------------------------------------------------------------------

/**
 * What the playthrough must exercise, so dialogue and combat are both really in the evidence.
 *
 * The split is not cosmetic. `attack` is in `REQUIRED_INTENTS` but not `REQUIRED_GM_TOOLS` because
 * in the recorded session the game master **never swung**: the player drew on Halloran, and the
 * model answered by opening the gate, moving the guard aside, advancing the quest and talking the
 * yard down. Requiring the model to attack would be requiring it to play badly, and a test that
 * demands a particular story is a test of the story, not of the loop. What must be true is that
 * the encounter really ran through the engine — an `attack` intent with a verdict, `end_turn`
 * passing initiative to an NPC the game master then played — and that is what these two lists say.
 */
const REQUIRED_INTENTS = ['say', 'attack', 'set_disposition', 'end_turn'] as const;
const REQUIRED_GM_TOOLS = ['say', 'set_disposition', 'end_turn'] as const;

function assertAcceptance(lines: RecordingLine[], playerTurns: number): void {
  const header = lines[0] as RecordingHeader;
  expect(header.line).toBe('header');
  const turns = lines.filter((l): l is RecordedTurn => l.line === 'turn');
  expect(turns.length).toBeGreaterThan(0);

  // ---- 1. zero direct state edits: the hash chain has no gaps -------------------------------
  let previous = header.hash;
  for (const turn of turns) {
    expect(turn.hashBefore).toBe(previous);
    previous = turn.hashAfter;
  }

  // ---- 2. every GM mutation carries an engine verdict ----------------------------------------
  const gmTurns = turns.filter((t) => t.toolCalls.length > 0);
  expect(gmTurns.length).toBeGreaterThan(0);
  for (const turn of turns) {
    expect(typeof turn.verdict.ok).toBe('boolean');
    for (const call of turn.toolCalls) {
      expect(call.verdict, `${call.name} was recorded without a verdict`).toBeDefined();
      expect(call.verdict.ok).toBe(turn.verdict.ok);
      if (!call.verdict.ok) expect(call.verdict.reason).toBeTruthy();
    }
    // A rejection changed nothing. The engine's contract, checked in the evidence.
    if (!turn.verdict.ok) {
      expect(turn.diffs).toEqual([]);
      expect(turn.hashAfter).toBe(turn.hashBefore);
    }
  }

  // Rejections are recorded too. Without this the evidence could not show the world saying no,
  // and a game master that tried something illegal would leave no trace.
  const rejected = gmTurns.filter((t) => !t.verdict.ok);
  expect(rejected.length, 'no rejected GM mutation in the recording').toBeGreaterThan(0);
  for (const turn of rejected) expect(turn.verdict.reason).toBeTruthy();

  // Every mutation the engine saw, whoever asked for it.
  const intents = new Set(turns.map((t) => t.intent.kind));
  for (const kind of REQUIRED_INTENTS) expect([...intents]).toContain(kind);
  // And the subset the game master asked for through `POST /gm/tool`.
  const tools = new Set(gmTurns.flatMap((t) => t.toolCalls.map((c) => c.name)));
  for (const tool of REQUIRED_GM_TOOLS) expect([...tools]).toContain(tool);
  // The encounter ran: initiative passed to an NPC and the game master took its turn.
  expect(turns.some((t) => t.intent.kind === 'attack' && t.verdict.ok)).toBe(true);

  // Ten player turns. Player commits are the ones with no tool call behind them.
  const playerCommits = turns.filter((t) => t.toolCalls.length === 0 && t.verdict.ok);
  expect(playerCommits.length).toBeGreaterThanOrEqual(playerTurns);

  // ---- 3. the recording replays to identical hashes -------------------------------------------
  const report = replay(lines, createEngine);
  expect(report.divergence?.reason ?? 'ok').toBe('ok');
  expect(report.ok).toBe(true);
  expect(report.turns).toBe(turns.length);
  expect(report.finalHash).toBe(report.recordedHash);
  expect(report.finalHash).toBe(previous);
}

// ---------------------------------------------------------------------------------------------
// Suite 1 — the committed evidence, replayed. No credentials, no Python, runs in `check`.
// ---------------------------------------------------------------------------------------------

describe('M1 acceptance evidence', () => {
  it('replays the recorded ten-turn playthrough to identical hashes', () => {
    assertAcceptance(parseRecording(readFileSync(FIXTURE, 'utf8')), BEATS.length);
  });
});

// ---------------------------------------------------------------------------------------------
// The ten turns
// ---------------------------------------------------------------------------------------------

interface ScriptedTurn {
  intent: Intent;
  text?: string;
}

/** What the player is trying to do on each of the ten turns. The shape of the story, not the moves. */
type Beat = 'hail' | 'approach' | 'ask-ilva' | 'plead' | 'fight';

/**
 * The playthrough: dialogue first, then a drawn sword, so `say`, `set_disposition`, `attack` and
 * `end_turn` all have a reason to appear.
 *
 * **The beats are fixed; the intents are not.** A first attempt at this hard-coded ten intents, and
 * it died on turn 5 against the live model with "(6, 5) is occupied." — the game master had walked
 * Halloran onto the tile the script was about to step on. That is not a flaw in the run, it is the
 * whole point of the milestone: the world moves between your decision and your next one. So each
 * turn is resolved against the **live snapshot** the way a UI resolves it, by offering the engine a
 * preference-ordered list of candidates and taking the first one it calls legal. That is
 * `legal_actions` by another name, and it is what keeps a ten-turn run reproducible without
 * pretending the game master will stand still.
 */
const BEATS: Beat[] = [
  'hail',
  'approach',
  'ask-ilva',
  'approach',
  'plead',
  'approach',
  'fight',
  'fight',
  'fight',
  'fight',
];

const SPEECH: Partial<Record<Beat, { line: string; to: EntityId; text: string }>> = {
  hail: {
    line: 'Hail the gate!',
    to: GUARD_ID,
    text: 'I want to get a wounded man through this gate. Who do I talk to?',
  },
  'ask-ilva': {
    line: 'Ilva, a word.',
    to: MERCHANT_ID,
    text: 'I ask Ilva whether she will vouch for me with the warden.',
  },
  plead: {
    line: 'Warden, the watchword is burned. Brannoc is bleeding out in your yard.',
    to: GUARD_ID,
    text: 'I tell Halloran the truth and ask him to open the gate for the scout.',
  },
};

const PLAYER: EntityId = 'player';

function positionOf(snapshot: Snapshot, id: EntityId): { x: number; y: number } | null {
  const p = snapshot.entities[id]?.components.position;
  return p ? { x: p.x, y: p.y } : null;
}

function chebyshev(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Alive entities the game master plays, nearest first. Who the player can talk to, or hit. */
function gmEntities(snapshot: Snapshot): EntityId[] {
  const me = positionOf(snapshot, PLAYER);
  return Object.values(snapshot.entities)
    .filter(
      (e) =>
        e.components.brain?.policy === GM_BRAIN_POLICY &&
        !e.components.health?.conditions.includes('dead') &&
        e.components.position,
    )
    .sort((a, b) => {
      if (!me) return 0;
      const pa = positionOf(snapshot, a.id)!;
      const pb = positionOf(snapshot, b.id)!;
      return chebyshev(me, pa) - chebyshev(me, pb);
    })
    .map((e) => e.id);
}

/**
 * Every tile on the map, ordered by how close it is to `goal` — the move candidates, best first.
 * Which of them are walkable, unoccupied and inside this turn's movement is the engine's answer,
 * not this function's, so the player simply walks as far toward the gate as the rules allow.
 */
function tilesToward(snapshot: Snapshot, goal: { x: number; y: number }): Intent[] {
  const map = Object.values(snapshot.world.maps)[0];
  if (!map) return [];
  const tiles: { x: number; y: number }[] = [];
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) tiles.push({ x, y });
  return tiles
    .sort((a, b) => chebyshev(a, goal) - chebyshev(b, goal))
    .map((to) => ({ kind: 'move', entity: PLAYER, to }) satisfies Intent);
}

/** Candidates for one beat, best first. The engine picks; this only says what the player wants. */
function candidates(beat: Beat, snapshot: Snapshot): Intent[] {
  const speech = SPEECH[beat];
  const nearby = gmEntities(snapshot);
  const guard = snapshot.entities[GUARD_ID] ? GUARD_ID : nearby[0];
  const me = positionOf(snapshot, PLAYER);
  const say = (to: EntityId | null, text: string): Intent => ({
    kind: 'say',
    speaker: PLAYER,
    text,
    to,
  });
  // Something the player can always do, so a turn never fails to commit: speaking needs only a
  // living speaker, and the engine has never refused it for anything else.
  const fallback: Intent[] = [
    ...nearby.map((id) => say(id, 'I am still here, and the scout is still bleeding.')),
    say(null, 'I am still here, and the scout is still bleeding.'),
  ];

  if (speech && snapshot.entities[speech.to]) return [say(speech.to, speech.line), ...fallback];

  if (beat === 'approach') {
    const goal = guard ? positionOf(snapshot, guard) : null;
    return goal ? [...tilesToward(snapshot, goal), ...fallback] : fallback;
  }

  // fight. Hit whoever is in reach; if nobody is, close the distance; if the encounter is running
  // and there is nothing to do, end the turn and let the game master have it.
  const adjacent = me ? nearby.filter((id) => chebyshev(me, positionOf(snapshot, id)!) <= 1) : [];
  const target = positionOf(snapshot, nearby[0] ?? PLAYER);
  return [
    ...adjacent.map(
      (id) =>
        ({ kind: 'attack', attacker: PLAYER, target: id, ability: 'longsword' }) satisfies Intent,
    ),
    { kind: 'end_turn', entity: PLAYER },
    ...(target ? tilesToward(snapshot, target) : []),
    ...fallback,
  ];
}

/**
 * The first candidate the engine accepts, resolved on a throwaway engine built from the live
 * snapshot. Exactly what a UI does when it greys out the actions you cannot take, and exactly what
 * preview does — the real engine is never asked, so choosing costs the world nothing.
 */
function choose(beat: Beat, snapshot: Snapshot): ScriptedTurn {
  for (const intent of candidates(beat, snapshot)) {
    const probe = createEngine(structuredClone(snapshot), { seed: GATEHOUSE_SEED });
    if (probe.apply(intent).ok) {
      const speech = SPEECH[beat];
      return speech && intent.kind === 'say' ? { intent, text: speech.text } : { intent };
    }
  }
  throw new Error(`no legal intent for beat ${beat}`);
}

// ---------------------------------------------------------------------------------------------
// Suite 1b — the policy itself, with no model in the loop. Free, and it runs in `check`.
// ---------------------------------------------------------------------------------------------

describe('the playthrough policy', () => {
  it('walks the player to the gate and starts a fight, from the gatehouse start', () => {
    // No game master: nobody moves but the player, which is the easy case. It is here to catch the
    // harness breaking — a beat with no legal candidate, or an approach that never arrives — rather
    // than to stand in for the live run, which is the only thing that proves the loop works.
    const engine = createEngine(gatehouseSnapshot(), { seed: GATEHOUSE_SEED });
    const kinds: string[] = [];
    for (const beat of BEATS) {
      const { intent } = choose(beat, engine.snapshot());
      const verdict = engine.apply(intent);
      expect(verdict.ok, `${beat}: ${verdict.reason ?? ''}`).toBe(true);
      kinds.push(intent.kind);
    }
    expect(kinds).toHaveLength(BEATS.length);
    expect(kinds).toContain('say');
    expect(kinds).toContain('move');
    // The encounter has to start, or the game master never takes an NPC turn and `attack` and
    // `end_turn` never appear in the evidence at all.
    expect(kinds).toContain('attack');
    expect(engine.snapshot().initiative).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Suite 2 — the live playthrough. Skipped without a key; CI has none.
// ---------------------------------------------------------------------------------------------

const live = Boolean(process.env['ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_AUTH_TOKEN']);

/** The beats the live run actually plays. Shortened only when smoke-testing the harness itself. */
const TURNS = BEATS.slice(0, Number(process.env['DELIBERATE_TURNS'] ?? BEATS.length));

/**
 * Phase budgets for the live run. The blueprint targets preview <= 8 s and resolve <= 6 s; a real
 * `claude-opus-5` turn with adaptive thinking and up to eight tool steps does not fit that today,
 * and a budget that always aborts would measure nothing. These are the ceilings the run is given;
 * what it actually took is printed at the end and belongs in the PR.
 */
const PREVIEW_MS = Number(process.env['DELIBERATE_PREVIEW_MS'] ?? 120_000);
const RESOLVE_MS = Number(process.env['DELIBERATE_RESOLVE_MS'] ?? 120_000);
const NARRATE_MS = Number(process.env['DELIBERATE_NARRATE_MS'] ?? 90_000);

describe.skipIf(!live)('M1 acceptance: ten-turn playthrough against the live model', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let gmProcess: ChildProcess | null = null;
  let recordingsDir: string;
  let nodeUrl = '';
  const usage: { phase: string; usage: Record<string, number> }[] = [];
  const timings: { turn: number; previewMs: number; goMs: number; afterGoMs: number }[] = [];

  beforeAll(async () => {
    const [nodePort, gmPort] = [await freePort(), await freePort()];
    nodeUrl = `http://127.0.0.1:${nodePort}`;
    recordingsDir = mkdtempSync(join(tmpdir(), 'deliberate-ale17-'));

    const inner = httpGmService({
      baseUrl: `http://127.0.0.1:${gmPort}`,
      timeoutMs: Math.max(PREVIEW_MS, RESOLVE_MS, NARRATE_MS),
    });
    // Tallies what the turn cost. The loop does not need `usage`, so it drops it; the acceptance
    // run is the one caller that has to report a price per turn.
    const gm: GmService = {
      async turn(request, options): Promise<GmTurnResponse> {
        const response = await inner.turn(request, options);
        usage.push({ phase: request.phase, usage: response.usage ?? {} });
        return response;
      },
    };

    app = await buildApp({
      scene: 'gatehouse',
      recordings: recordingsDir,
      gm,
      budgets: { preview: PREVIEW_MS, resolve: RESOLVE_MS, narrate: NARRATE_MS },
    });
    await app.listen({ port: nodePort, host: '127.0.0.1' });

    gmProcess = spawn(
      join(repoRoot, 'services/gm/.venv/bin/python'),
      ['-m', 'uvicorn', 'deliberate_gm.app:app', '--host', '127.0.0.1', '--port', String(gmPort)],
      {
        cwd: join(repoRoot, 'services/gm'),
        env: { ...process.env, GM_ENGINE_URL: `http://127.0.0.1:${nodePort}` },
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    await waitForHealth(`http://127.0.0.1:${gmPort}/healthz`);
  }, 120_000);

  afterAll(async () => {
    gmProcess?.kill('SIGTERM');
    await app?.close();
    if (!process.env['DELIBERATE_KEEP_RECORDING'])
      rmSync(recordingsDir, { recursive: true, force: true });
  });

  it(
    'plays ten turns, records every GM mutation with its verdict, and replays to identical hashes',
    async () => {
      const path = app.recording!.path;
      const client = await connect(app);
      client.send({ type: 'join', room: app.room.id, protocol: PROTOCOL_VERSION });
      expect((await client.next()).type).toBe('snapshot');

      for (const [index, beat] of TURNS.entries()) {
        const turn = app.room.turn();
        expect(turn).toBe(index);

        const hashBeforePreview = app.room.engine.hash();
        // Composed against the world as it is now, not as it was when this file was written.
        const scripted = choose(beat, app.room.engine.snapshot());
        const previewAt = Date.now();
        client.send({
          type: 'preview_request',
          room: app.room.id,
          turn,
          intent: scripted.intent,
          ...(scripted.text ? { text: scripted.text } : {}),
        });
        const preview = await client.next(PREVIEW_MS + 30_000);
        expect(preview.type, `turn ${turn}: ${JSON.stringify(preview)}`).toBe('preview');
        const previewMs = Date.now() - previewAt;

        // Preview must not have moved the world, however much the game master did to the clone.
        // The clone is the mechanism (ALE-32); this is the check that it held on a live turn.
        expect(app.room.engine.hash(), `turn ${turn}: preview mutated the real engine`).toBe(
          hashBeforePreview,
        );

        const goAt = Date.now();
        client.send({ type: 'go', room: app.room.id, turn });
        // GO's own work — re-validating the player's intent on the real engine — is synchronous.
        // Everything after it is the game master resolving NPC turns and narrating.
        await waitUntil(() => app.room.turn() === turn + 1, RESOLVE_MS + NARRATE_MS + 60_000);
        const goMs = Date.now() - goAt;
        await app.gm.idle();
        await app.gm.idle();
        const afterGoMs = Date.now() - goAt;
        timings.push({ turn, previewMs, goMs, afterGoMs });
      }

      await client.close();
      expect(app.room.turn()).toBe(TURNS.length);

      // --- the refused mutation -----------------------------------------------------------
      // Ten turns of a well-behaved game master need not contain an illegal move, and the claim
      // that a refusal reaches the recording must not rest on the model misbehaving. So one
      // deliberately illegal call goes through the very same `POST /gm/tool` door the Python
      // service uses, naming a speaker who is not in the world. The engine refuses it, the
      // refusal lands in the recording beside its reason, and nothing moved — which is the claim.
      // How many refusals the model earned on its own is reported below, not asserted.
      const beforeRefusal = app.room.engine.hash();
      const refused = await fetch(`${nodeUrl}/gm/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session: app.room.id,
          turn: app.room.turn(),
          engine_token: 'live',
          call_id: 'ale17-illegal',
          tool: 'say',
          input: { npc_id: 'nobody', text: 'I am not here.', to: null },
        }),
      });
      const verdict = (await refused.json()) as { ok: boolean; reason: string | null };
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBeTruthy();
      expect(app.room.engine.hash()).toBe(beforeRefusal);

      const finalHash = app.room.engine.hash();

      // The recording is only complete once the file is closed with the app.
      await app.close();
      if (process.env['DELIBERATE_WRITE_FIXTURE']) copyFileSync(path, FIXTURE);

      const lines = parseRecording(readFileSync(path, 'utf8'));
      report(timings, usage, lines);
      assertAcceptance(lines, TURNS.length);
      // The live engine and a fresh engine fed only the recorded intents agree, byte for byte.
      expect(replay(lines, createEngine).finalHash).toBe(finalHash);
    },
    30 * 60_000,
  );
});

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

function report(
  timings: { turn: number; previewMs: number; goMs: number; afterGoMs: number }[],
  usage: { phase: string; usage: Record<string, number> }[],
  lines: RecordingLine[],
): void {
  const totals = usage.reduce(
    (acc, u) => {
      for (const [k, v] of Object.entries(u.usage)) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    },
    {} as Record<string, number>,
  );
  // The same prices and the same split the meters bill with (ALE-24), so the acceptance report
  // and the recording's own summary can never disagree about what a turn cost.
  const dollars = usdFor(tokensFrom(totals));
  const turns = timings.length || 1;
  const mean = (pick: (t: (typeof timings)[number]) => number): number =>
    Math.round(timings.reduce((a, t) => a + pick(t), 0) / turns);
  console.log('\n--- ALE-17 ten-turn playthrough ---');
  console.table(timings);
  console.log(
    `preview mean ${mean((t) => t.previewMs)} ms | GO->turn mean ${mean((t) => t.goMs)} ms | ` +
      `GO->idle mean ${mean((t) => t.afterGoMs)} ms`,
  );
  console.log(`model calls ${usage.length} | tokens ${JSON.stringify(totals)}`);
  console.log(`$${dollars.toFixed(4)} total, $${(dollars / turns).toFixed(4)} per turn`);
  // And the same thing again, read back out of the recording the server wrote — which is what
  // `pnpm meters <file>` prints, and what M3's "p50 after GO < 10 s" is graded on (ALE-24).
  console.log(`\n--- meters, from the recording ---\n${formatSummary(summarize(lines))}`);
  const gm = lines.filter((l): l is RecordedTurn => l.line === 'turn' && l.toolCalls.length > 0);
  // Refusals the model earned on its own, as opposed to the one the test drove deliberately.
  const earned = gm.filter(
    (l) => !l.verdict.ok && l.toolCalls.every((c) => c.args['npc_id'] !== 'nobody'),
  );
  console.log(
    `recorded lines ${lines.length} | GM mutations ${gm.length} | ` +
      `refusals the model earned ${earned.length}` +
      (earned.length ? `: ${earned.map((l) => l.verdict.reason).join(' / ')}` : ''),
  );
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address !== 'string' ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

async function waitUntil(ready: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the turn to commit');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`the GM service never answered ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

interface ScriptedClient {
  send(frame: unknown): void;
  next(timeoutMs?: number): Promise<ServerMessage>;
  close(): Promise<void>;
}

/** Joins over a real socket: the acceptance run travels the protocol, not an in-process shortcut. */
async function connect(app: Awaited<ReturnType<typeof buildApp>>): Promise<ScriptedClient> {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  const queue: ServerMessage[] = [];
  const waiting: ((message: ServerMessage) => void)[] = [];
  ws.on('message', (data) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    // Narration and committed diffs are broadcast asynchronously; the driver waits on the frames
    // that answer what it sent, so they are dropped here rather than desynchronising the queue.
    if (message.type === 'narration' || message.type === 'diffs') return;
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else queue.push(message);
  });
  await new Promise<void>((done, fail) => {
    ws.once('open', () => done());
    ws.once('error', fail);
  });
  return {
    send: (frame) => ws.send(JSON.stringify(frame)),
    next: (timeoutMs = 30_000) => {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<ServerMessage>((done, fail) => {
        const timer = setTimeout(() => fail(new Error('timed out waiting for a frame')), timeoutMs);
        waiting.push((message) => {
          clearTimeout(timer);
          done(message);
        });
      });
    },
    close: () =>
      new Promise<void>((done) => {
        ws.once('close', () => done());
        ws.close();
      }),
  };
}
