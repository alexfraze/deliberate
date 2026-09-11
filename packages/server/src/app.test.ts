import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { FIXTURE_PLAYER_ID, FIXTURE_DUMMY_IDS } from '@deliberate/engine';
import {
  PROTOCOL_VERSION,
  type DiffsMessage,
  type ErrorMessage,
  type ServerMessage,
  type SnapshotMessage,
} from '@deliberate/protocol';

import { buildApp } from './app.js';
import type { TurnCommit } from './room.js';

/**
 * End-to-end over a real socket with the real engine: a scripted client joins, moves, attacks,
 * and is refused. This is the ALE-11 "done when" and the closest thing to the acceptance run
 * (ALE-13) that lives inside the server package.
 */

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;

beforeEach(async () => {
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await app.close();
});

interface ScriptedClient {
  send(frame: unknown): void;
  sendRaw(text: string): void;
  /** Resolves with the next server frame, in arrival order. */
  next(): Promise<ServerMessage>;
  close(): Promise<void>;
}

async function connect(): Promise<ScriptedClient> {
  const ws = new WebSocket(`ws://${baseUrl}/ws`);
  const queue: ServerMessage[] = [];
  const waiting: ((message: ServerMessage) => void)[] = [];
  ws.on('message', (data) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else queue.push(message);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return {
    send: (frame) => ws.send(JSON.stringify(frame)),
    sendRaw: (text) => ws.send(text),
    next: () => {
      const queued = queue.shift();
      return queued
        ? Promise.resolve(queued)
        : new Promise<ServerMessage>((resolve) => waiting.push(resolve));
    },
    close: () =>
      new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        ws.close();
      }),
  };
}

/** Joins and returns the snapshot frame. */
async function join(client: ScriptedClient): Promise<SnapshotMessage> {
  client.send({ type: 'join', room: 'main', protocol: PROTOCOL_VERSION });
  const reply = await client.next();
  expect(reply.type).toBe('snapshot');
  return reply as SnapshotMessage;
}

const moveTo = (turn: number, x: number, y: number) => ({
  type: 'intent',
  room: 'main',
  turn,
  intent: { kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x, y } },
});

describe('http', () => {
  it('answers /healthz with the versions and the room state', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      protocol: PROTOCOL_VERSION,
      room: 'main',
      turn: 0,
    });
  });
});

describe('turn protocol over a websocket', () => {
  it('replies to join with the authoritative snapshot at turn 0', async () => {
    const client = await connect();
    const snapshot = await join(client);
    expect(snapshot).toMatchObject({ room: 'main', turn: 0 });
    expect(Object.keys(snapshot.snapshot.entities).sort()).toEqual(
      [FIXTURE_PLAYER_ID, ...FIXTURE_DUMMY_IDS].sort(),
    );
    expect(snapshot.hash).toMatch(/^[0-9a-f]+$/);
    await client.close();
  });

  it('turns a move intent into a diff stream at turn + 1', async () => {
    const client = await connect();
    const snapshot = await join(client);

    client.send(moveTo(0, 4, 2));
    const reply = (await client.next()) as DiffsMessage;

    expect(reply.type).toBe('diffs');
    expect(reply.turn).toBe(1);
    expect(reply.hash).not.toBe(snapshot.hash);
    expect(reply.diffs).toHaveLength(1);
    expect(reply.diffs[0]).toMatchObject({
      type: 'EntityMoved',
      entity: FIXTURE_PLAYER_ID,
      from: { x: 2, y: 2 },
      to: { x: 4, y: 2 },
    });
    await client.close();
  });

  it('refuses an illegal move with a reason a player can read and does not advance the turn', async () => {
    const client = await connect();
    const before = await join(client);

    client.send(moveTo(0, 3, 4)); // a pillar
    const reply = (await client.next()) as ErrorMessage;

    expect(reply.type).toBe('error');
    expect(reply.turn).toBe(0);
    expect(reply.reason).toContain('cannot be walked on');

    const after = await join(client);
    expect(after.turn).toBe(0);
    expect(after.hash).toBe(before.hash);
    await client.close();
  });

  it('refuses an out-of-range attack with the engine reason', async () => {
    const client = await connect();
    await join(client);

    client.send({
      type: 'intent',
      room: 'main',
      turn: 0,
      intent: {
        kind: 'attack',
        attacker: FIXTURE_PLAYER_ID,
        target: FIXTURE_DUMMY_IDS[0],
        ability: 'longsword',
      },
    });
    const reply = (await client.next()) as ErrorMessage;

    expect(reply.type).toBe('error');
    expect(reply.reason).toMatch(/ft away/);
    await client.close();
  });

  it('refuses a stale turn and resends the snapshot', async () => {
    const client = await connect();
    await join(client);
    client.send(moveTo(0, 4, 2));
    expect((await client.next()).type).toBe('diffs');

    client.send(moveTo(0, 5, 2)); // composed against the turn that already resolved
    const error = (await client.next()) as ErrorMessage;
    const resync = (await client.next()) as SnapshotMessage;

    expect(error.type).toBe('error');
    expect(error.reason).toContain('turn 1');
    expect(resync).toMatchObject({ type: 'snapshot', turn: 1 });
    await client.close();
  });

  it('refuses a malformed frame without closing the socket', async () => {
    const client = await connect();
    await join(client);

    client.sendRaw('{ not json');
    expect((await client.next()).type).toBe('error');

    client.send(moveTo(0, 4, 2));
    expect((await client.next()).type).toBe('diffs');
    await client.close();
  });

  it('broadcasts committed diffs to every joined client', async () => {
    const mover = await connect();
    const watcher = await connect();
    await join(mover);
    await join(watcher);

    mover.send(moveTo(0, 4, 2));

    expect((await mover.next()).type).toBe('diffs');
    expect((await watcher.next()).type).toBe('diffs');
    await Promise.all([mover.close(), watcher.close()]);
  });

  it('announces each committed turn for the recorder (ALE-30)', async () => {
    const commits: TurnCommit[] = [];
    app.room.onTurn((commit) => commits.push(commit));

    const client = await connect();
    const before = await join(client);
    client.send(moveTo(0, 4, 2));
    await client.next();
    client.send(moveTo(1, 3, 4)); // refused: no event
    await client.next();

    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ room: 'main', turn: 0, hashBefore: before.hash });
    expect(commits[0]?.verdict.ok).toBe(true);
    expect(commits[0]?.hashAfter).not.toBe(before.hash);
    await client.close();
  });
});
