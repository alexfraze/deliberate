import { describe, expect, it } from 'vitest';

import { createEngine } from '@deliberate/engine';
import {
  GATEHOUSE_SEED,
  GATEHOUSE_PLAYER_ID,
  GUARD_ID,
  MERCHANT_ID,
  NPC_ARCHETYPES,
  gatehouseSnapshot,
  npcEntity,
} from '@deliberate/npcs';
import {
  DEFAULT_ROOM,
  type Entity,
  type Intent,
  type NarrationMessage,
  type PreviewMessage,
  type ServerMessage,
  type Snapshot,
} from '@deliberate/protocol';

import { createRoom, type RoomSocket, type TurnCommit } from '../room.js';
import { createEngineRegistry, LIVE_ENGINE_TOKEN } from './engines.js';
import { createGmLoop, gmActor } from './loop.js';
import type { GmTurnRequest } from './service.js';
import { stubGmService, type ScriptedTurn } from './stub.js';
import { executeGmToolRequest, parseGmToolRequest } from './tool.js';

/**
 * ALE-32's acceptance evidence.
 *
 * The rule these tests exist to prove is **preview does not mutate**: a preview in which the game
 * master successfully changed several things must leave the real engine byte-identical. It is
 * asserted on the state hash, which is the same canonical digest the recording and the replay
 * check use, so "identical" here means identical to the only definition the project has.
 *
 * Everything runs against the real engine, the real gatehouse scene and a scripted game master.
 * The stub is not a mock of the loop: it makes its calls through the same `/gm/tool` door the
 * Python service uses, so a rejection here is the engine's rejection.
 */

const TEMPLATES: Record<string, Entity> = Object.fromEntries(
  NPC_ARCHETYPES.map((npc) => [npc.archetype, npcEntity(npc)]),
);

type Script = (request: GmTurnRequest) => ScriptedTurn;

function fakeSocket(): RoomSocket & { received: ServerMessage[] } {
  const received: ServerMessage[] = [];
  return {
    received,
    send(data) {
      received.push(JSON.parse(data) as ServerMessage);
    },
  };
}

function harness(script?: Script) {
  const engine = createEngine(gatehouseSnapshot(), {
    seed: GATEHOUSE_SEED,
    templates: TEMPLATES,
  });
  const room = createRoom({ engine });
  const registry = createEngineRegistry({ engine, seed: GATEHOUSE_SEED, templates: TEMPLATES });
  const asked: GmTurnRequest[] = [];
  const deps = { registry, room };
  const gm = script
    ? stubGmService({
        script: (request) => {
          asked.push(request);
          return script(request);
        },
        call: (request) => executeGmToolRequest(deps, request),
      })
    : null;
  const loop = createGmLoop({ room, registry, gm });
  room.setGmFrames((socket, message) => loop.handle(socket, message));

  const commits: TurnCommit[] = [];
  room.onTurn((commit) => commits.push(commit));

  const socket = fakeSocket();
  room.handle(socket, { type: 'join', room: DEFAULT_ROOM, protocol: 1 });
  socket.received.length = 0;

  const preview = async (intent: Intent | null, text?: string): Promise<void> => {
    room.handle(socket, {
      type: 'preview_request',
      room: DEFAULT_ROOM,
      turn: room.turn(),
      intent,
      ...(text === undefined ? {} : { text }),
    });
    await loop.idle();
  };
  const go = async (): Promise<void> => {
    room.handle(socket, { type: 'go', room: DEFAULT_ROOM, turn: room.turn() });
    await loop.idle();
  };

  return { engine, room, registry, loop, socket, asked, commits, deps, preview, go };
}

function last<T>(items: T[]): T | undefined {
  return items.at(-1);
}

function of<T extends ServerMessage['type']>(
  messages: ServerMessage[],
  type: T,
): Extract<ServerMessage, { type: T }>[] {
  return messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
}

function entityAt(snapshot: Snapshot, id: string): { x: number; y: number } {
  const position = snapshot.entities[id]?.components.position;
  return { x: position?.x ?? -1, y: position?.y ?? -1 };
}

const MOVE_NORTH: Intent = { kind: 'move', entity: GATEHOUSE_PLAYER_ID, to: { x: 2, y: 8 } };
const MOVE_EAST: Intent = { kind: 'move', entity: GATEHOUSE_PLAYER_ID, to: { x: 3, y: 9 } };

/** A game master that speaks, changes how it feels, and sets a flag. All of it must be speculative. */
const BUSY_GM: Script = (request) =>
  request.phase === 'preview'
    ? {
        narration: 'Halloran shifts his weight and watches you come.',
        calls: [
          { tool: 'get_state', input: { scope: 'entities', entity_id: null } },
          { tool: 'set_flag', input: { key: 'gatehouse.watchword.burned', value: true } },
          { tool: 'say', input: { npc_id: GUARD_ID, text: 'Far enough.', to: null } },
          {
            tool: 'set_disposition',
            input: { npc_id: GUARD_ID, toward: GATEHOUSE_PLAYER_ID, delta: -5, reason: 'armed' },
          },
        ],
      }
    : { narration: 'The yard is quiet again.' };

describe('preview does not mutate', () => {
  it('leaves the real engine byte-identical after a preview the GM mutated on', async () => {
    const h = harness(BUSY_GM);
    const before = h.engine.hash();
    const snapshotBefore = h.engine.snapshot();

    await h.preview(MOVE_NORTH, 'I am only passing through.');

    expect(h.engine.hash()).toBe(before);
    expect(h.engine.snapshot()).toEqual(snapshotBefore);
    // Nothing committed, so the room is still on the turn the preview was composed against.
    expect(h.room.turn()).toBe(0);
    expect(h.commits).toHaveLength(0);
  });

  it('really did apply those mutations — on the clone', async () => {
    const h = harness(BUSY_GM);
    await h.preview(MOVE_NORTH);

    const preview = last(of(h.socket.received, 'preview')) as PreviewMessage;
    expect(preview.text).toContain('Halloran');
    // The player's move, the guard's line, the disposition and the flag: all four resolved, and
    // none of them happened. A preview with an empty diff would make the hash assertion vacuous.
    expect(preview.diffs.map((d) => d.type)).toEqual([
      'EntityMoved',
      'FlagSet',
      'DialogueLine',
      'DispositionChanged',
    ]);
  });

  it('throws the clone away, so a late tool call cannot land on it', async () => {
    const h = harness(BUSY_GM);
    await h.preview(MOVE_NORTH);
    expect(h.registry.clones()).toBe(0);

    const late = executeGmToolRequest(h.deps, {
      session: DEFAULT_ROOM,
      turn: 0,
      engineToken: 'preview-1',
      callId: null,
      tool: 'set_flag',
      input: { key: 'gatehouse.gate.sealed', value: false },
    });
    expect(late.ok).toBe(false);
    expect(late.reason).toContain('preview it belonged to is over');
    expect(h.engine.snapshot().world.flags['gatehouse.gate.sealed']).toBe(true);
  });

  it('refuses an illegal intent from the clone, and the real engine never sees it', async () => {
    const h = harness(BUSY_GM);
    const before = h.engine.hash();
    // (0, 0) is wall.
    await h.preview({ kind: 'move', entity: GATEHOUSE_PLAYER_ID, to: { x: 0, y: 0 } });

    expect(last(of(h.socket.received, 'error'))?.reason).toContain('cannot be walked on');
    expect(of(h.socket.received, 'preview')).toHaveLength(0);
    expect(h.engine.hash()).toBe(before);
    expect(h.loop.pending()).toBeNull();
  });
});

describe('GO', () => {
  it('lets a player preview, change their mind, preview again, and commit the last one', async () => {
    const h = harness(BUSY_GM);

    await h.preview(MOVE_NORTH);
    expect(entityAt(h.engine.snapshot(), GATEHOUSE_PLAYER_ID)).toEqual({ x: 2, y: 9 });

    await h.preview(MOVE_EAST);
    expect(h.loop.pending()?.intent).toEqual(MOVE_EAST);

    await h.go();
    expect(entityAt(h.engine.snapshot(), GATEHOUSE_PLAYER_ID)).toEqual({ x: 3, y: 9 });
    expect(h.room.turn()).toBe(1);
    // One player turn, however many tool calls the game master made inside it.
    expect(h.commits.filter((c) => c.source === 'player')).toHaveLength(1);
  });

  it('re-validates every previewed call against the real engine and stops at the first refusal', async () => {
    const h = harness(BUSY_GM);
    await h.preview(MOVE_NORTH);

    // The world moves between the preview and GO: something else burns the watchword. The GM's
    // previewed `set_flag` is now a no-op the engine refuses, and the call after it was planned on
    // a world that did not happen, so it is not attempted either.
    h.room.commitGmCall(
      { kind: 'set_flag', key: 'gatehouse.watchword.burned', value: true },
      { name: 'set_flag', args: { key: 'gatehouse.watchword.burned', value: true } },
    );
    const dispositionBefore =
      h.engine.snapshot().entities[GUARD_ID]?.components.disposition?.toward[GATEHOUSE_PLAYER_ID] ??
      0;

    await h.go();

    // The player's own move committed; the GM's stale batch did not resume past the refusal.
    expect(entityAt(h.engine.snapshot(), GATEHOUSE_PLAYER_ID)).toEqual({ x: 2, y: 8 });
    const refused = h.commits.filter((c) => c.source === 'gm' && !c.verdict.ok);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.verdict.reason).toContain('already');
    expect(
      h.engine.snapshot().entities[GUARD_ID]?.components.disposition?.toward[GATEHOUSE_PLAYER_ID] ??
        0,
    ).toBe(dispositionBefore);
  });

  it('refuses a GO with no preview behind it', async () => {
    const h = harness(BUSY_GM);
    await h.go();
    expect(last(of(h.socket.received, 'error'))?.reason).toContain('Preview an action');
    expect(h.room.turn()).toBe(0);
  });

  it('records every GM mutation with the engine verdict that decided it', async () => {
    const h = harness(BUSY_GM);
    await h.preview(MOVE_NORTH);
    await h.go();

    const gmCommits = h.commits.filter((c) => c.source === 'gm');
    expect(gmCommits.map((c) => c.toolCalls[0]?.name)).toEqual([
      'set_flag',
      'say',
      'set_disposition',
    ]);
    for (const commit of gmCommits) {
      expect(commit.toolCalls[0]?.verdict).toBe(commit.verdict);
      expect(commit.verdict.ok).toBe(true);
    }
  });
});

describe('resolve and narrate', () => {
  /** Fights: the player swings, and the NPCs answer through the game master. */
  const COMBAT_GM: Script = (request) => {
    if (request.phase === 'narrate')
      return { narration: 'Steel, and then the yard holding still.' };
    if (request.phase !== 'resolve') return { narration: 'You weigh it up.' };
    const acting = (request.state as { acting: string | null }).acting;
    if (!acting) return {};
    return {
      narration: '',
      calls: [
        { tool: 'say', input: { npc_id: acting, text: 'Hold!', to: GATEHOUSE_PLAYER_ID } },
        { tool: 'end_turn', input: { entity_id: acting } },
      ],
    };
  };

  it('gives an NPC its turn through the game master, on the real engine', async () => {
    const h = harness(COMBAT_GM);

    // Walk up to the merchant and swing: the first attack rolls initiative for everyone.
    await h.preview({ kind: 'move', entity: GATEHOUSE_PLAYER_ID, to: { x: 2, y: 6 } });
    await h.go();
    await h.preview({
      kind: 'attack',
      attacker: GATEHOUSE_PLAYER_ID,
      target: MERCHANT_ID,
      ability: 'longsword',
    });
    await h.go();
    expect(h.engine.snapshot().initiative).not.toBeNull();

    // The player's turn ends, and initiative now has somewhere to go: `advanceTurn` stops on a
    // `gm` brain, and resolve asks the game master what that entity does.
    await h.preview({ kind: 'end_turn', entity: GATEHOUSE_PLAYER_ID });
    await h.go();

    const resolved = h.asked.filter((r) => r.phase === 'resolve');
    expect(resolved.length).toBeGreaterThan(0);
    const acted = resolved.map((r) => (r.state as { acting: string | null }).acting);
    expect(acted.every((id) => id !== null && id !== GATEHOUSE_PLAYER_ID)).toBe(true);
    // Every NPC turn came back round to the player, so the encounter is playable.
    expect(gmActor(h.engine.snapshot())).toBeNull();
    // The NPCs spoke through the engine: those lines are diffs, not prose the model asserted.
    const dialogue = h.commits.filter((c) => c.intent.kind === 'say');
    expect(dialogue.length).toBeGreaterThan(0);
  });

  it('ends a turn the game master leaves open, so a silence cannot stall the encounter', async () => {
    // This game master talks and never ends its turn.
    const h = harness((request) =>
      request.phase === 'resolve'
        ? {
            calls: [
              {
                tool: 'say',
                input: {
                  npc_id: (request.state as { acting: string }).acting,
                  text: '…',
                  to: null,
                },
              },
            ],
          }
        : {},
    );

    await h.preview({ kind: 'move', entity: GATEHOUSE_PLAYER_ID, to: { x: 2, y: 6 } });
    await h.go();
    await h.preview({
      kind: 'attack',
      attacker: GATEHOUSE_PLAYER_ID,
      target: MERCHANT_ID,
      ability: 'longsword',
    });
    await h.go();
    await h.preview({ kind: 'end_turn', entity: GATEHOUSE_PLAYER_ID });
    await h.go();

    expect(gmActor(h.engine.snapshot())).toBeNull();
    const forced = h.commits.filter((c) => c.source === 'gm' && c.intent.kind === 'end_turn');
    expect(forced.length).toBeGreaterThan(0);
  });

  it('streams narration to the room and closes the stream', async () => {
    const h = harness(BUSY_GM);
    await h.preview(MOVE_NORTH);
    await h.go();

    const narration = of(h.socket.received, 'narration') as NarrationMessage[];
    expect(narration.length).toBeGreaterThan(1);
    expect(narration.map((n) => n.chunk).join('')).toBe('The yard is quiet again.');
    expect(last(narration)?.done).toBe(true);
  });
});

describe('without a game master', () => {
  it('still previews and commits, showing the engine’s own resolution', async () => {
    const h = harness();
    const before = h.engine.hash();

    await h.preview(MOVE_NORTH);
    expect(h.engine.hash()).toBe(before);
    const preview = last(of(h.socket.received, 'preview')) as PreviewMessage;
    expect(preview.diffs.map((d) => d.type)).toEqual(['EntityMoved']);
    expect(preview.text).toContain('no game master');

    await h.go();
    expect(entityAt(h.engine.snapshot(), GATEHOUSE_PLAYER_ID)).toEqual({ x: 2, y: 8 });
  });
});

describe('the /gm/tool door', () => {
  it('answers a query without touching the world or the RNG', () => {
    const h = harness();
    const before = h.engine.hash();
    const response = executeGmToolRequest(h.deps, {
      session: DEFAULT_ROOM,
      turn: 0,
      engineToken: LIVE_ENGINE_TOKEN,
      callId: 'c1',
      tool: 'get_state',
      input: { scope: 'entities', entity_id: null },
    });
    expect(response.ok).toBe(true);
    expect(response.kind).toBe('query');
    expect(response.diff).toEqual([]);
    expect(response.result).toBeTruthy();
    expect(h.engine.hash()).toBe(before);
    expect(h.commits).toHaveLength(0);
  });

  it('leaves state untouched when the engine rejects a mutation', () => {
    const h = harness();
    const before = h.engine.hash();
    const response = executeGmToolRequest(h.deps, {
      session: DEFAULT_ROOM,
      turn: 0,
      engineToken: LIVE_ENGINE_TOKEN,
      callId: 'c1',
      tool: 'say',
      input: { npc_id: 'nobody-at-all', text: 'hello', to: null },
    });
    expect(response.ok).toBe(false);
    expect(response.kind).toBe('mutation');
    expect(response.reason).toContain('nobody-at-all');
    expect(response.diff).toEqual([]);
    expect(h.engine.hash()).toBe(before);
  });

  it('refuses a tool that is not in the contract', () => {
    const h = harness();
    const response = executeGmToolRequest(h.deps, {
      session: DEFAULT_ROOM,
      turn: 0,
      engineToken: LIVE_ENGINE_TOKEN,
      callId: null,
      tool: 'delete_everything',
      input: {},
    });
    expect(response.ok).toBe(false);
    expect(response.reason).toContain('no tool called delete_everything');
  });

  it('checks the body before anything else looks at it', () => {
    expect(parseGmToolRequest(null).ok).toBe(false);
    expect(parseGmToolRequest({ tool: 42 }).ok).toBe(false);
    expect(parseGmToolRequest({ tool: 'say', input: 'not an object' }).ok).toBe(false);
    const parsed = parseGmToolRequest({ tool: 'say', input: { npc_id: 'x' }, turn: 3 });
    expect(parsed).toMatchObject({ ok: true, request: { tool: 'say', turn: 3 } });
  });
});
