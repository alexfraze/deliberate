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
import { createRoom, type Room } from './room.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** The single M0 room. Exposed so the recorder (ALE-30/ALE-13) can `app.room.onTurn(...)`. */
    room: Room;
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
  /** Seed for the default engine. Ignored when `engine` is injected. */
  seed?: Seed;
  room?: RoomId;
}

/**
 * Builds the Fastify app without listening, so tests can `app.inject()` and open sockets against
 * an ephemeral port. `/ws` speaks the turn protocol in docs/protocol.md against a single room.
 */
export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(websocket);

  const engine =
    opts.engine ?? createEngine(fixtureSnapshot(), { seed: opts.seed ?? FIXTURE_SEED });
  const room = createRoom(opts.room ? { engine, id: opts.room } : { engine });
  app.decorate('room', room);

  app.get('/healthz', async () => ({
    ok: true,
    engine: ENGINE_VERSION,
    protocol: PROTOCOL_VERSION,
    room: room.id,
    turn: room.turn(),
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
