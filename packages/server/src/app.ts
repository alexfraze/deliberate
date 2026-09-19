import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import {
  createEngine,
  engineFromSave,
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
  type SaveFile,
  type Seed,
  type Snapshot,
} from '@deliberate/protocol';

import { parseClientFrame, toText } from './frames.js';
import { createEngineRegistry } from './gm/engines.js';
import { createGmLoop, type GmLoop } from './gm/loop.js';
import type { GmHealth, GmService } from './gm/service.js';
import { executeGmToolRequest, parseGmToolRequest } from './gm/tool.js';
import { recordSession, type Recording } from './recording.js';
import { createRoom, type Room } from './room.js';
import { saveSlot, type SaveSlot } from './save.js';

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

/** The scene a save names, when this build still has it. Anything else falls back to the default. */
export function sceneName(name: string | null | undefined): SceneName | null {
  return name === 'fixture' || name === 'gatehouse' ? name : null;
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
    /** The JSON save slot (ALE-23), or null when `saves` was not asked for. */
    save: SaveSlot | null;
  }
}

export interface AppOptions {
  logger?: boolean;
  /**
   * Engine the room drives. Defaults to the real `createEngine` over the M0 fixture snapshot;
   * tests inject a fake so they never depend on the rules. TODO(ALE-13): the acceptance issue
   * may replace this default with a map/seed chosen at startup. An injected engine wins over
   * `load`: the save's turn counter and memory still apply, its store and dice position do not.
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
  /**
   * Entries the preview and NPC-decision caches keep (ALE-22). `0` turns caching off, which is
   * what a test measuring the cold path wants. `src/index.ts` reads it from the environment.
   */
  cacheSize?: number;
  /**
   * Speculative previews the server will pay for per player turn (ALE-40). `0` is the kill switch.
   * Defaults to `MAX_SPECULATIONS_PER_TURN`; `src/index.ts` reads it from `GM_SPECULATE`.
   */
  speculationsPerTurn?: number;
  /** Dollars of speculation per player turn (ALE-40). Defaults to `MAX_SPECULATION_USD`. */
  speculationUsdPerTurn?: number;
  room?: RoomId;
  /**
   * Directory for JSONL session recordings. `null` (the default) records nothing, which is what
   * unit tests and CI want; `src/index.ts` passes `recordings`. The file is closed with the app.
   */
  recordings?: string | null;
  /**
   * A save to resume (ALE-23). Its snapshot, seed, RNG stream position, turn counter and GM
   * memory blocks replace the scene's, so the room picks the session up exactly where it stopped
   * — including the next roll. `src/index.ts` reads the file; taking the parsed document rather
   * than a path keeps `buildApp` free of I/O.
   */
  load?: SaveFile | null;
  /**
   * Directory `POST /save` writes to. `null` (the default) means no save route, which is what
   * unit tests want; `src/index.ts` passes `saves`.
   */
  saves?: string | null;
}

/**
 * Builds the Fastify app without listening, so tests can `app.inject()` and open sockets against
 * an ephemeral port. `/ws` speaks the turn protocol in docs/protocol.md against a single room.
 */
export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(websocket);

  const loaded = opts.load ?? null;
  // A save names the scene it was booted from, so `spawn` templates come back with it.
  const name = opts.scene ?? sceneName(loaded?.scene) ?? 'gatehouse';
  const scene = loadScene(name);
  const seed = opts.seed ?? loaded?.seed ?? scene.seed;
  const engine =
    opts.engine ??
    (loaded
      ? engineFromSave(loaded, { templates: scene.templates })
      : createEngine(scene.snapshot, { seed, templates: scene.templates }));
  const room = createRoom({
    engine,
    ...(opts.room ? { id: opts.room } : {}),
    ...(loaded ? { turn: loaded.turn } : {}),
  });
  app.decorate('room', room);

  // One registry per room. It holds the real engine and mints clones for previews; `/gm/tool`
  // resolves an `engine_token` through it, and nothing else can reach the live engine.
  const registry = createEngineRegistry({ engine, seed, templates: scene.templates });
  // Created before the loop so the loop's meters have somewhere to go. It subscribes to the room
  // and nothing else, so the ordering costs nothing.
  const recording = opts.recordings
    ? recordSession(room, { dir: opts.recordings, seed, templates: scene.templates })
    : null;
  // Null means no model anywhere in the loop: preview is the engine's own resolution and GO
  // commits it. That is a legitimate mode, but it has to be *visible* (ALE-39) — see `/healthz`.
  const gmService = opts.gm ?? null;
  const gm = createGmLoop({
    room,
    registry,
    gm: gmService,
    ...(loaded ? { memory: loaded.memory } : {}),
    ...(opts.budgets?.preview ? { previewBudgetMs: opts.budgets.preview } : {}),
    ...(opts.budgets?.resolve ? { resolveBudgetMs: opts.budgets.resolve } : {}),
    ...(opts.budgets?.narrate ? { narrateBudgetMs: opts.budgets.narrate } : {}),
    ...(opts.cacheSize === undefined ? {} : { cacheSize: opts.cacheSize }),
    ...(opts.speculationsPerTurn === undefined
      ? {}
      : { speculationsPerTurn: opts.speculationsPerTurn }),
    ...(opts.speculationUsdPerTurn === undefined
      ? {}
      : { speculationUsdPerTurn: opts.speculationUsdPerTurn }),
    log: (message) => app.log.warn(message),
    // One `meter` line per turn (ALE-24), so what a turn cost is re-readable from the recording
    // months later instead of trusted from whatever printed it at the time.
    onMeter: (entry) => recording?.recorder.meter(entry),
  });
  app.decorate('gm', gm);
  room.setGmFrames((socket, message) => gm.handle(socket, message));

  app.decorate('recording', recording);
  app.addHook('onClose', () => recording?.close());

  const slot = opts.saves ? saveSlot(room, gm, { dir: opts.saves, seed, scene: name }) : null;
  app.decorate('save', slot);
  if (slot) {
    // Saving is a player action, not a lifecycle event: the room keeps running, and the file is
    // replaced. Loading is a restart — `src/index.ts` reads the file before the app is built.
    app.post('/save', async (_request, reply) => {
      const written = slot.write();
      return reply.send({ ok: true, path: slot.path, turn: written.turn, hash: written.hash });
    });
  }

  /**
   * Whether a game master is actually behind this server, for the client to put on screen. The
   * default UI path never calls the model, and a silent engine-only turn is indistinguishable
   * from a game master that answered instantly — so the answer has to be askable (ALE-39).
   */
  const gmStatus = async (): Promise<{
    configured: boolean;
    reachable: boolean;
    model: string | null;
    narrateModel: string | null;
  }> => {
    if (!gmService) {
      return { configured: false, reachable: false, model: null, narrateModel: null };
    }
    // An injected service with no probe (the scripted stub, ALE-17's fakes) is taken at its word.
    if (!gmService.health) {
      return { configured: true, reachable: true, model: null, narrateModel: null };
    }
    const health: GmHealth | null = await gmService.health();
    return {
      configured: true,
      reachable: health !== null,
      model: health?.model ?? null,
      narrateModel: health?.narrateModel ?? null,
    };
  };

  app.get('/healthz', async () => ({
    ok: true,
    engine: ENGINE_VERSION,
    protocol: PROTOCOL_VERSION,
    room: room.id,
    turn: room.turn(),
    // The JSONL this session is being written to, so `pnpm replay` (and the acceptance suite)
    // knows which file to check. Null when recording is off.
    recording: recording?.path ?? null,
    // Preview and NPC-decision cache hit rates for this session (ALE-22).
    cache: gm.cache(),
    // Turns the world took off its own bat, and how many of them a saved policy took with no
    // model call (ALE-41 / ALE-37). `npcTurns` well under `turns` is the feature working: most
    // quiet turns should find nobody with anything to react to.
    ambient: gm.ambient(),
    // What the player's pointer has been allowed to spend this turn, and what it was refused
    // (ALE-40). `budget: 0` means speculation is switched off on this server.
    speculation: gm.speculation(),
    // p50/p95 after GO and cost per turn so far (ALE-24). The same numbers `pnpm meters` prints
    // from the recording afterwards, available while the session is still running.
    meters: gm.meters(),
    // Where `POST /save` writes (ALE-23). Null when saving is off.
    save: slot?.path ?? null,
    // Is there a model in this loop at all, and which one (ALE-39).
    gm: await gmStatus(),
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
