import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURE_DUMMY_IDS, FIXTURE_PLAYER_ID } from '@deliberate/engine';
import { DEFAULT_ROOM, type Intent, type SaveFile } from '@deliberate/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp, type AppOptions } from './app.js';
import type { GmService, GmTurnRequest, MemoryBlocks } from './gm/service.js';
import { readSave, saveFileName } from './save.js';

/**
 * ALE-23's "done when": save → restart → load produces the same hash and the game master
 * continues coherently.
 *
 * "Restart" here is a second `buildApp` from the file on disk — a different process's worth of
 * state, rebuilt from nothing but the JSON. The three things it has to bring back are the store,
 * the place the dice had got to, and what the GM remembers; this file tests each one, and the
 * roll sequence is tested by making a roll *after* the load rather than by comparing hashes at
 * the moment of loading, which would pass with the RNG position thrown away.
 */

const P = FIXTURE_PLAYER_ID;
const A = FIXTURE_DUMMY_IDS[0];

const move = (x: number, y: number): Intent => ({ kind: 'move', entity: P, to: { x, y } });
const attack = (): Intent => ({ kind: 'attack', attacker: P, target: A, ability: 'longsword' });
const endTurn = (): Intent => ({ kind: 'end_turn', entity: P });

let dir: string | undefined;
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/**
 * A game master that does nothing but remember. The tool path is ALE-32's test; what matters here
 * is that the blocks Node persists survive a restart and are handed back to the model next turn.
 */
function rememberingGm(seen: GmTurnRequest[]): GmService {
  return {
    async turn(request) {
      seen.push(request);
      const ledger = Array.isArray(request.memory['ledger']) ? request.memory['ledger'] : [];
      const memory: MemoryBlocks = {
        ...request.memory,
        world_model: ['The training yard has two dummies in it.'],
        ledger: [...ledger, { turn: request.turn, phase: request.phase, ok: true }],
      };
      return { narration: 'The yard is quiet.', trace: [], stop_reason: 'end_turn', memory };
    },
  };
}

async function boot(options: AppOptions): Promise<Awaited<ReturnType<typeof buildApp>>> {
  const app = await buildApp({ scene: 'fixture', ...options });
  apps.push(app);
  return app;
}

/** One preview-then-GO through the loop, which is what gives the GM a turn to remember. */
async function gmTurn(app: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
  const socket = { send: () => {} };
  app.room.handle(socket, { type: 'join', room: DEFAULT_ROOM, protocol: 1 });
  const turn = app.room.turn();
  app.room.handle(socket, { type: 'preview_request', room: DEFAULT_ROOM, turn, intent: null });
  await app.gm.idle();
  app.room.handle(socket, { type: 'go', room: DEFAULT_ROOM, turn });
  await app.gm.idle();
}

function commit(app: Awaited<ReturnType<typeof buildApp>>, intents: Intent[]): void {
  for (const intent of intents) {
    const verdict = app.room.commit(intent);
    expect(verdict.ok, `${intent.kind}: ${verdict.reason ?? ''}`).toBe(true);
  }
}

/** Plays a session and saves it. Returns the still-running app and the file it wrote. */
async function playAndSave(): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  saved: SaveFile;
  seen: GmTurnRequest[];
}> {
  dir = mkdtempSync(join(tmpdir(), 'deliberate-saves-'));
  const seen: GmTurnRequest[] = [];
  const app = await boot({ saves: dir, gm: rememberingGm(seen) });
  // A move, then an attack: the attack rolls initiative for everyone and then rolls to hit, so
  // the RNG is well past its start by the time the save is taken.
  commit(app, [move(7, 3), attack()]);
  await gmTurn(app);

  const response = await app.inject({ method: 'POST', url: '/save' });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ ok: true, path: join(dir, saveFileName(DEFAULT_ROOM)) });
  return { app, saved: readSave(join(dir, saveFileName(DEFAULT_ROOM))), seen };
}

describe('save and load', () => {
  it('writes a save naming the room, the turn, the seed and where the dice had got to', async () => {
    const { app, saved } = await playAndSave();
    expect(saved.save).toBe(1);
    expect(saved.room).toBe(DEFAULT_ROOM);
    expect(saved.scene).toBe('fixture');
    expect(saved.turn).toBe(app.room.turn());
    expect(saved.hash).toBe(app.room.engine.hash());
    expect(saved.rngCalls).toBe(app.room.engine.rngCalls());
    expect(saved.rngCalls).toBeGreaterThan(0);
  });

  it('restarts into the same hash, the same turn and the same GM memory', async () => {
    const { app, saved } = await playAndSave();
    const seen: GmTurnRequest[] = [];
    const loaded = await boot({ load: saved, gm: rememberingGm(seen) });

    expect(loaded.room.engine.hash()).toBe(app.room.engine.hash());
    expect(loaded.room.engine.snapshot()).toEqual(app.room.engine.snapshot());
    expect(loaded.room.turn()).toBe(app.room.turn());
    expect(loaded.gm.memory()).toEqual(app.gm.memory());

    // Coherence is not "the blocks are in a variable": the next turn's prompt has to carry them
    // back to the model, verified ledger and world model included.
    await gmTurn(loaded);
    expect(seen[0]?.memory).toEqual(app.gm.memory());
    expect(seen[0]?.memory['world_model']).toEqual(['The training yard has two dummies in it.']);
  });

  it('continues the roll sequence: the next attack is the one the session would have made', async () => {
    const { app, saved } = await playAndSave();
    const loaded = await boot({ load: saved });

    // The same next turn on both, after the round trip. The store alone would have restored the
    // hash and then re-rolled the dice from the top of the seed's stream.
    const next = [endTurn(), attack()];
    const uninterrupted = next.map((intent) => app.room.commit(intent));
    const resumed = next.map((intent) => loaded.room.commit(intent));
    expect(uninterrupted.every((v) => v.ok)).toBe(true);
    expect(resumed).toEqual(uninterrupted);
    expect(loaded.room.engine.hash()).toBe(app.room.engine.hash());
    expect(loaded.room.engine.rngCalls()).toBe(app.room.engine.rngCalls());

    // The control, so this test cannot pass for the wrong reason: the same file with the stream
    // position dropped loads to the same hash and then rolls something else.
    const naive = await boot({ load: { ...saved, rngCalls: 0 } });
    expect(naive.room.engine.hash()).toBe(saved.hash);
    expect(next.map((intent) => naive.room.commit(intent))).not.toEqual(uninterrupted);
  });

  it('refuses a save this build cannot read rather than booting half a world', async () => {
    const { saved } = await playAndSave();
    const future = { ...saved, save: 2 } as unknown as SaveFile;
    await expect(boot({ load: future })).rejects.toThrow(/save version 2/);
  });

  it('has no save route when no directory was asked for', async () => {
    const app = await boot({});
    expect(app.save).toBeNull();
    expect((await app.inject({ method: 'POST', url: '/save' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json()).toMatchObject({
      save: null,
    });
  });
});
