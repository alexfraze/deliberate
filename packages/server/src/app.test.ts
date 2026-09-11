import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type { ServerMessage } from '@deliberate/protocol';

import { buildApp } from './app.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;

beforeAll(async () => {
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
});

describe('server skeleton', () => {
  it('answers /healthz', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, protocol: 1 });
  });

  it('accepts a websocket and replies with a typed message', async () => {
    const ws = new WebSocket(`ws://${baseUrl}/ws`);
    const reply = await new Promise<ServerMessage>((resolve, reject) => {
      ws.once('open', () => ws.send(JSON.stringify({ type: 'join', room: 'main', protocol: 1 })));
      ws.once('message', (data) => resolve(JSON.parse(String(data)) as ServerMessage));
      ws.once('error', reject);
    });
    ws.close();
    expect(reply.type).toBe('error');
  });
});
