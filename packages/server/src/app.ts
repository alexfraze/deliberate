import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import {
  createEngine,
  ENGINE_VERSION,
  FIXTURE_SEED,
  fixtureSnapshot,
  type Engine,
} from '@deliberate/engine';
import { PROTOCOL_VERSION, type RoomId, type Seed } from '@deliberate/protocol';

import { parseClientFrame, toText } from './frames.js';
import { recordSession, type Recording } from './recording.js';
import { createRoom, type Room } from './room.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The single M0 room. Exposed so the recorder (ALE-30/ALE-13) can `app.room.onTurn(...)`. */
    room: Room;
    /** The JSONL session recording, or null when `recordings` was not asked for. */
    recording: Recording | null;
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

  const seed = opts.seed ?? FIXTURE_SEED;
  const engine = opts.engine ?? createEngine(fixtureSnapshot(), { seed });
  const room = createRoom(opts.room ? { engine, id: opts.room } : { engine });
  app.decorate('room', room);

  const recording = opts.recordings ? recordSession(room, { dir: opts.recordings, seed }) : null;
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
