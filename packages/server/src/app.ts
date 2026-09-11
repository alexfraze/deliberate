import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { ENGINE_VERSION } from '@deliberate/engine';
import { DEFAULT_ROOM, PROTOCOL_VERSION, type ErrorMessage } from '@deliberate/protocol';

export interface AppOptions {
  logger?: boolean;
}

/**
 * Builds the Fastify app without listening, so tests can `app.inject()` and open sockets against
 * an ephemeral port. TODO(ALE-11): replace the placeholder `/ws` handler with the turn protocol
 * (join → snapshot, intent → diffs | error) backed by a single in-memory room.
 */
export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(websocket);

  app.get('/healthz', async () => ({
    ok: true,
    engine: ENGINE_VERSION,
    protocol: PROTOCOL_VERSION,
  }));

  app.get('/ws', { websocket: true }, (socket) => {
    socket.on('message', () => {
      const reply: ErrorMessage = {
        type: 'error',
        room: DEFAULT_ROOM,
        turn: null,
        reason: 'turn protocol not implemented yet (ALE-11)',
      };
      socket.send(JSON.stringify(reply));
    });
  });

  return app;
}
