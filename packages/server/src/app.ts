import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import {
  createEngine,
  ENGINE_VERSION,
  FIXTURE_SEED,
  fixtureSnapshot,
  type Engine,
} from '@deliberate/engine';
import { GATEHOUSE_SEED, NPC_ARCHETYPES, gatehouseSnapshot, npcEntity } from '@deliberate/npcs';
import {
  PROTOCOL_VERSION,
  type Entity,
  type RoomId,
  type Seed,
  type Snapshot,
} from '@deliberate/protocol';

import { parseClientFrame, toText } from './frames.js';
import { createEngineRegistry } from './gm/engines.js';
import { createGmLoop, type GmLoop } from './gm/loop.js';
import type { GmService } from './gm/service.js';
import { executeGmToolRequest, parseGmToolRequest } from './gm/tool.js';
import { recordSession, type Recording } from './recording.js';
import { createRoom, type Room } from './room.js';

/**
 * Which world the room boots. `gatehouse` is the M1 scene (ALE-16): a guard, a merchant and a
 * wounded scout the game master plays. `fixture` is the M0 training yard, which the acceptance
 * suite (ALE-13) plays by UI alone and replays hash-for-hash, so it stays selectable.
 */
export type SceneName = 'gatehouse' | 'fixture';

interface Scene {
  snapshot: Snapshot;
  seed: Seed;
  /** Entity templates the GM's `spawn` tool may instantiate, keyed by template id. */
  templates: Record<string, Entity>;
}

export function loadScene(name: SceneName): Scene {
  if (name === 'fixture') {
    return { snapshot: fixtureSnapshot(), seed: FIXTURE_SEED, templates: {} };
  }
  return {
    snapshot: gatehouseSnapshot(),
    seed: GATEHOUSE_SEED,
    templates: Object.fromEntries(NPC_ARCHETYPES.map((npc) => [npc.archetype, npcEntity(npc)])),
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The single M0 room. Exposed so the recorder (ALE-30/ALE-13) can `app.room.onTurn(...)`. */
    room: Room;
    /** The JSONL session recording, or null when `recordings` was not asked for. */
    recording: Recording | null;
    /** The preview-then-GO loop (ALE-32). Always present; the game master behind it may not be. */
    gm: GmLoop;
  }
}

export interface AppOptions {
  logger?: boolean;
  /**
   * Engine the room drives. Defaults to the real `createEngine` over the M0 fixture snapshot;
   * tests inject a fake so they never depend on the rules. TODO(ALE-13): the acceptance issue
   * may replace this default with a map/seed chosen at startup.
   */
  engine?: Engine;
  /** Seed for the default engine, and the seed written into a recording's header. */
  seed?: Seed;
  /** Which world to boot when no `engine` was injected. Defaults to the M1 gatehouse. */
  scene?: SceneName;
  /**
   * The game master behind the preview-then-GO loop. `null` (the default) runs the loop with no
   * model: preview shows the engine's own resolution of the staged intent and GO commits it, which
   * is what the M0 acceptance path and a credential-free machine want.
   */
  gm?: GmService | null;
  /**
   * Per-phase ceilings on the game master, in milliseconds. Defaults are the blueprint's
   * (`PREVIEW_BUDGET_MS` and friends). They are an option because the blueprint's numbers are a
   * target the model does not meet yet: a real `claude-opus-5` turn with adaptive thinking and a
   * tool loop takes tens of seconds, and a budget that always aborts turns "the GM is slow" into
   * "the GM never answered". `src/index.ts` reads them from the environment; ALE-17 passes its own.
   */
  budgets?: { preview?: number; resolve?: number; narrate?: number };
  room?: RoomId;
  /**
   * Directory for JSONL session recordings. `null` (the default) records nothing, which is what
   * unit tests and CI want; `src/index.ts` passes `recordings`. The file is closed with the app.
   */
  recordings?: string | null;
}

/**
 * Builds the Fastify app without listening, so tests can `app.inject()` and open sockets against
 * an ephemeral port. `/ws` speaks the turn protocol in docs/protocol.md against a single room.
 */
export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(websocket);

  const scene = loadScene(opts.scene ?? 'gatehouse');
  const seed = opts.seed ?? scene.seed;
  const engine = opts.engine ?? createEngine(scene.snapshot, { seed, templates: scene.templates });
  const room = createRoom(opts.room ? { engine, id: opts.room } : { engine });
  app.decorate('room', room);

  // One registry per room. It holds the real engine and mints clones for previews; `/gm/tool`
  // resolves an `engine_token` through it, and nothing else can reach the live engine.
  const registry = createEngineRegistry({ engine, seed, templates: scene.templates });
  const gm = createGmLoop({
    room,
    registry,
    gm: opts.gm ?? null,
    ...(opts.budgets?.preview ? { previewBudgetMs: opts.budgets.preview } : {}),
    ...(opts.budgets?.resolve ? { resolveBudgetMs: opts.budgets.resolve } : {}),
    ...(opts.budgets?.narrate ? { narrateBudgetMs: opts.budgets.narrate } : {}),
    log: (message) => app.log.warn(message),
  });
  app.decorate('gm', gm);
  room.setGmFrames((socket, message) => gm.handle(socket, message));

  const recording = opts.recordings
    ? recordSession(room, { dir: opts.recordings, seed, templates: scene.templates })
    : null;
  app.decorate('recording', recording);
  app.addHook('onClose', () => recording?.close());

  app.get('/healthz', async () => ({
    ok: true,
    engine: ENGINE_VERSION,
    protocol: PROTOCOL_VERSION,
    room: room.id,
    turn: room.turn(),
    // The JSONL this session is being written to, so `pnpm replay` (and the acceptance suite)
    // knows which file to check. Null when recording is off.
    recording: recording?.path ?? null,
  }));

  /**
   * The only door into the engine for the game master (decision 1 of docs/m1-swarm.md). The Python
   * service calls this once per tool use, echoing the `engine_token` it was given: the live engine
   * during resolve and narrate, a throwaway clone during a preview.
   */
  app.post('/gm/tool', async (request, reply) => {
    const parsed = parseGmToolRequest(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({
        ok: false,
        kind: 'mutation',
        reason: parsed.reason,
        diff: [],
        result: null,
        state_hash: null,
      });
    }
    return executeGmToolRequest({ registry, room }, parsed.request);
  });

  app.get('/ws', { websocket: true }, (socket) => {
    socket.on('message', (raw) => {
      const frame = parseClientFrame(toText(raw));
      if (!frame.ok) {
        room.refuse(socket, frame.reason);
        return;
      }
      room.handle(socket, frame.message);
    });
    socket.on('close', () => room.leave(socket));
  });

  return app;
}
