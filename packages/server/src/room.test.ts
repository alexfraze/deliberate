import { describe, expect, it } from 'vitest';

import type { Engine } from '@deliberate/engine';
import {
  PROTOCOL_VERSION,
  type Intent,
  type ServerMessage,
  type Snapshot,
  type Verdict,
} from '@deliberate/protocol';

import { createRoom, type RoomSocket, type TurnCommit } from './room.js';

/**
 * These tests use a fake `Engine`, which is the point of injecting one: the room's contract is
 * "ask the engine, relay the verdict", and it must hold whatever the rules do.
 */

const emptySnapshot = (): Snapshot => ({
  schema: PROTOCOL_VERSION,
  entities: {},
  world: { flags: {}, quests: {}, clock: 0, maps: {} },
  initiative: null,
});

interface FakeEngine extends Engine {
  applied: Intent[];
}

function fakeEngine(verdicts: Verdict[]): FakeEngine {
  const applied: Intent[] = [];
  let version = 0;
  return {
    applied,
    snapshot: emptySnapshot,
    hash: () => `hash-${version}`,
    rngCalls: () => version,
    apply(intent) {
      applied.push(intent);
      const verdict = verdicts.shift() ?? { ok: false, reason: 'no verdict queued', diff: [] };
      if (verdict.ok) version += 1;
      return verdict;
    },
  };
}

function fakeSocket(): RoomSocket & { received: ServerMessage[] } {
  const received: ServerMessage[] = [];
  return {
    received,
    send(data) {
      received.push(JSON.parse(data) as ServerMessage);
    },
  };
}

const move: Intent = { kind: 'move', entity: 'p', to: { x: 1, y: 1 } };

describe('room', () => {
  it('replies to join with the snapshot and its hash', () => {
    const room = createRoom({ engine: fakeEngine([]) });
    const socket = fakeSocket();
    room.handle(socket, { type: 'join', room: 'main', protocol: PROTOCOL_VERSION });
    expect(room.size()).toBe(1);
    expect(socket.received).toEqual([
      { type: 'snapshot', room: 'main', turn: 0, snapshot: emptySnapshot(), hash: 'hash-0' },
    ]);
  });

  it('commits an accepted intent, advances the turn, and broadcasts the diffs', () => {
    const diff = { type: 'FlagSet', key: 'moved', value: true } as const;
    const room = createRoom({ engine: fakeEngine([{ ok: true, diff: [diff] }]) });
    const a = fakeSocket();
    const b = fakeSocket();
    for (const s of [a, b])
      room.handle(s, { type: 'join', room: 'main', protocol: PROTOCOL_VERSION });

    room.handle(a, { type: 'intent', room: 'main', turn: 0, intent: move });

    expect(room.turn()).toBe(1);
    const expected = { type: 'diffs', room: 'main', turn: 1, diffs: [diff], hash: 'hash-1' };
    expect(a.received.at(-1)).toEqual(expected);
    expect(b.received.at(-1)).toEqual(expected);
  });

  it('relays the verdict reason and leaves the turn alone when the engine refuses', () => {
    const room = createRoom({
      engine: fakeEngine([{ ok: false, reason: 'There is a wall.', diff: [] }]),
    });
    const socket = fakeSocket();
    room.handle(socket, { type: 'join', room: 'main', protocol: PROTOCOL_VERSION });

    room.handle(socket, { type: 'intent', room: 'main', turn: 0, intent: move });

    expect(room.turn()).toBe(0);
    expect(socket.received.at(-1)).toEqual({
      type: 'error',
      room: 'main',
      turn: 0,
      reason: 'There is a wall.',
    });
  });

  it('refuses a stale turn without asking the engine, then resyncs the client', () => {
    const engine = fakeEngine([]);
    const room = createRoom({ engine });
    const socket = fakeSocket();
    room.handle(socket, { type: 'join', room: 'main', protocol: PROTOCOL_VERSION });

    room.handle(socket, { type: 'intent', room: 'main', turn: 7, intent: move });

    expect(engine.applied).toEqual([]);
    expect(socket.received.map((m) => m.type)).toEqual(['snapshot', 'error', 'snapshot']);
    expect(socket.received[1]).toMatchObject({ type: 'error', turn: 0 });
  });

  it('refuses an intent from a socket that never joined, and an unknown room', () => {
    const room = createRoom({ engine: fakeEngine([]) });
    const socket = fakeSocket();
    room.handle(socket, { type: 'intent', room: 'main', turn: 0, intent: move });
    room.handle(socket, { type: 'join', room: 'elsewhere', protocol: PROTOCOL_VERSION });
    expect(room.size()).toBe(0);
    expect(socket.received.map((m) => m.type)).toEqual(['error', 'error']);
  });

  it('announces committed turns to listeners and stops on unsubscribe', () => {
    const room = createRoom({
      engine: fakeEngine([
        { ok: true, diff: [] },
        { ok: false, reason: 'nope', diff: [] },
        { ok: true, diff: [] },
      ]),
    });
    const socket = fakeSocket();
    room.handle(socket, { type: 'join', room: 'main', protocol: PROTOCOL_VERSION });

    const seen: TurnCommit[] = [];
    const off = room.onTurn((commit) => seen.push(commit));

    room.handle(socket, { type: 'intent', room: 'main', turn: 0, intent: move });
    room.handle(socket, { type: 'intent', room: 'main', turn: 1, intent: move }); // refused
    off();
    room.handle(socket, { type: 'intent', room: 'main', turn: 1, intent: move });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      room: 'main',
      turn: 0,
      intent: move,
      hashBefore: 'hash-0',
      hashAfter: 'hash-1',
    });
    expect(room.turn()).toBe(2);
  });

  it('stops broadcasting to a socket that left', () => {
    const room = createRoom({ engine: fakeEngine([{ ok: true, diff: [] }]) });
    const gone = fakeSocket();
    const here = fakeSocket();
    for (const s of [gone, here])
      room.handle(s, { type: 'join', room: 'main', protocol: PROTOCOL_VERSION });
    room.leave(gone);

    room.handle(here, { type: 'intent', room: 'main', turn: 0, intent: move });

    expect(gone.received.map((m) => m.type)).toEqual(['snapshot']);
    expect(here.received.map((m) => m.type)).toEqual(['snapshot', 'diffs']);
  });
});
