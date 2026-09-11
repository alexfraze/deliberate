import { describe, expect, it } from 'vitest';

import { httpGmService, type GmTurnRequest, type GmTurnResponse } from './service.js';

/**
 * The Node → Python hop. There is no Python running in this suite and no credentials on this
 * machine, so what is checked here is the thing that would silently break across the boundary: the
 * field names. They are asserted against `docs/gm-service.md` and against
 * `services/gm/src/deliberate_gm/models.py`, because a request with a mis-spelled key does not
 * fail loudly — Pydantic fills in a default and the game master quietly plays the wrong turn.
 */

const REQUEST: GmTurnRequest = {
  session: 'main',
  turn: 4,
  phase: 'preview',
  engine_token: 'preview-2',
  state: { acting: null },
  entities: ['player'],
  player_intent: { kind: 'end_turn', entity: 'player' },
  player_text: 'I lower the sword.',
  memory: { turns: 3 },
};

const RESPONSE: GmTurnResponse = {
  narration: 'Halloran does not lower his.',
  trace: [],
  stop_reason: 'end_turn',
  memory: { turns: 4 },
};

describe('the GM service client', () => {
  it('sends exactly the fields `POST /turn` is documented to take', async () => {
    let seen: Record<string, unknown> = {};
    const service = httpGmService({
      baseUrl: 'http://127.0.0.1:8788/',
      fetch: async (_url, init) => {
        seen = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify(RESPONSE), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const chunks: string[] = [];
    const response = await service.turn(REQUEST, { onChunk: (c) => chunks.push(c) });

    expect(Object.keys(seen).sort()).toEqual([
      'engine_token',
      'entities',
      'memory',
      'phase',
      'player_intent',
      'player_text',
      'session',
      'state',
      'turn',
    ]);
    expect(response.memory).toEqual({ turns: 4 });
    expect(chunks.join('')).toBe(RESPONSE.narration);
  });

  it('posts to /turn on the configured base URL, trailing slash or not', async () => {
    let url = '';
    const service = httpGmService({
      baseUrl: 'http://127.0.0.1:8788/',
      fetch: async (target) => {
        url = String(target);
        return new Response(JSON.stringify(RESPONSE));
      },
    });
    await service.turn(REQUEST);
    expect(url).toBe('http://127.0.0.1:8788/turn');
  });

  it('turns a non-2xx answer into an error rather than a half-parsed turn', async () => {
    const service = httpGmService({
      baseUrl: 'http://127.0.0.1:8788',
      fetch: async () => new Response('no credentials', { status: 503 }),
    });
    await expect(service.turn(REQUEST)).rejects.toThrow('answered 503');
  });

  it('gives up rather than hanging the room', async () => {
    const service = httpGmService({
      baseUrl: 'http://127.0.0.1:8788',
      timeoutMs: 10,
      // A service that never answers. Without the timeout this promise never settles and the
      // room is wedged for the life of the process.
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await expect(service.turn(REQUEST)).rejects.toThrow();
  });
});
