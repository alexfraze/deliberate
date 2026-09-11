import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEngine, FIXTURE_PLAYER_ID, replay } from '@deliberate/engine';
import { readLines } from '@deliberate/engine/fs';
import {
  DEFAULT_ROOM,
  PROTOCOL_VERSION,
  type ClientMessage,
  type Intent,
} from '@deliberate/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { recordingFileName } from './recording.js';

/**
 * The M0 exit criterion, without a browser: a session played against the real engine is written to
 * JSONL and replays through a fresh engine to identical hashes. The e2e suite does the same thing
 * through the UI and the CLI; this keeps it covered by `pnpm check` on a runner with no browser.
 */

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** The room only needs `send`; nothing here reads what the server sent back. */
function sink(): { send(data: string): void } {
  return { send: () => {} };
}

describe('session recording', () => {
  it('names files so they sort by time and survive a Windows checkout', () => {
    expect(recordingFileName(new Date('2026-09-11T16:20:30.123Z'))).toBe(
      '2026-09-11T16-20-30-123Z.jsonl',
    );
  });

  it('records nothing unless a directory is asked for', async () => {
    const app = await buildApp();
    expect(app.recording).toBeNull();
    await app.close();
  });

  it('records a played session to JSONL that replays to identical hashes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'deliberate-rec-'));
    const app = await buildApp({ recordings: dir });
    const socket = sink();
    const play = (message: ClientMessage): void => app.room.handle(socket, message);

    play({ type: 'join', room: DEFAULT_ROOM, protocol: PROTOCOL_VERSION });
    // Walk into reach of dummy A at (8, 3), swing twice (the second is refused: the action is
    // spent), end the turn, then swing again in round 2.
    const intents: Intent[] = [
      { kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x: 5, y: 2 } },
      { kind: 'move', entity: FIXTURE_PLAYER_ID, to: { x: 7, y: 3 } },
      { kind: 'attack', attacker: FIXTURE_PLAYER_ID, target: 'dummy-a', ability: 'longsword' },
      { kind: 'attack', attacker: FIXTURE_PLAYER_ID, target: 'dummy-a', ability: 'longsword' },
      { kind: 'end_turn', entity: FIXTURE_PLAYER_ID },
      { kind: 'attack', attacker: FIXTURE_PLAYER_ID, target: 'dummy-a', ability: 'longsword' },
    ];
    // Compose each intent against the turn the room is on, the way a live client does.
    for (const intent of intents) {
      play({ type: 'intent', room: DEFAULT_ROOM, turn: app.room.turn(), intent });
    }

    const path = app.recording!.path;
    const hash = app.room.engine.hash();
    await app.close();

    const lines = readLines(path);
    // Header plus one line per committed turn. One of the six intents was refused by the engine,
    // and a refusal never commits, so five turns are on file.
    expect(lines).toHaveLength(1 + 5);
    expect(app.room.turn()).toBe(5);

    const report = replay(lines, createEngine);
    expect(report.divergence).toBeUndefined();
    expect(report.ok).toBe(true);
    expect(report.turns).toBe(5);
    expect(report.finalHash).toBe(hash);
  });
});
