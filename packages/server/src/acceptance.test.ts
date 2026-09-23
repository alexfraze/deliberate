import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
  createEngine,
  formatSummary,
  parseRecording,
  path,
  replay,
  summarize,
  type Engine,
} from '@deliberate/engine';
import {
  GATEHOUSE_SEED,
  GUARD_ID,
  MERCHANT_ID,
  NPC_ARCHETYPES,
  SCOUT_ID,
  gatehouseSnapshot,
  npcEntity,
} from '@deliberate/npcs';
import {
  PROTOCOL_VERSION,
  type Diff,
  type EntityId,
  type Intent,
  type MapId,
  type MapRecord,
  type RecordedMeter,
  type RecordedTurn,
  type RecordingHeader,
  type RecordingLine,
  type ServerMessage,
  type Snapshot,
  type Tile,
} from '@deliberate/protocol';

import { buildApp } from './app.js';
import { ambientCandidates } from './gm/ambient.js';
import type { CacheStats } from './gm/cache.js';
import { GM_BRAIN_POLICY } from './gm/loop.js';
import { tokensFrom, usdFor } from './gm/meters.js';
import { httpGmService, type GmService, type GmTurnResponse } from './gm/service.js';

/**
 * M1 acceptance (ALE-17). The exit criterion for the milestone, in three claims, each of which is
 * checked **against the recording** rather than against the code that wrote it:
 *
 * 1. **Zero direct state edits.** Every hash in the recording chains: the header's hash is the
 *    first line's `hashBefore`, every line's `hashAfter` is the next line's `hashBefore`, and a
 *    fresh engine replaying nothing but the recorded intents arrives at the recorded final hash.
 *    A mutation that reached the store by any other road would break that chain, because the
 *    replay engine would never make it.
 * 2. **Every GM mutation carries an engine verdict.** Each line the game master caused carries the
 *    tool call that asked for it beside the `Verdict` the engine answered with — including the
 *    rejections, which must leave the hash where it was and carry a player-readable reason.
 * 3. **The recording replays to identical hashes.** `replay` is the CLI's own function.
 *
 * ALE-25 (M3 acceptance) asks for **three** recorded playthroughs rather than one, so the same
 * three claims are now made of three different stories: `m1-acceptance`, `yard-brawl` and
 * `parley`. See `SCRIPTS` below for what each one is.
 *
 * There are two kinds of suite. The first replays the **committed** recordings, so the acceptance
 * evidence is re-checkable in CI with no credentials and no Python. The second **regenerates**
 * one: it boots the Python GM service against the real Claude API and plays ten turns through the
 * preview-then-GO loop. That one needs a key and money, so it is skipped without
 * `ANTHROPIC_API_KEY` — the required `check` job must never depend on a model.
 *
 *   source ~/.deliberate-env && pnpm --filter @deliberate/server test -- acceptance
 *   DELIBERATE_SCRIPT=parley DELIBERATE_WRITE_FIXTURE=1 pnpm --filter @deliberate/server test -- acceptance
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

/**
 * The committed evidence: the JSONL that real ten-turn playthroughs against `claude-opus-5` wrote.
 *
 * Replaying one needs the engine and nothing else: no key, no model, no network. So an expensive
 * live run becomes a permanent free regression artifact, and anyone who later changes the rules,
 * the hash or the diff set gets an immediate failure showing they broke determinism against a real
 * model-driven session.
 *
 * They live in `recordings/bank/`, which is committed (only `recordings/*.jsonl` is ignored),
 * because ALE-21 grew the first one into the regression bank: the three live entries are replayed
 * with the rest by `pnpm bank` and `src/bank/bank.test.ts`. This suite keeps its own assertions
 * because they are about the milestone, not about determinism.
 */
const BANK = resolve(repoRoot, 'recordings/bank');

function bankFile(play: Playthrough): string {
  return resolve(BANK, play.file);
}

// ---------------------------------------------------------------------------------------------
// The assertions. One function, run against the committed recording and against a fresh one.
// ---------------------------------------------------------------------------------------------

/**
 * A named playthrough: what the player tries to do on each turn, and what the resulting evidence
 * must contain. Three of them are committed to the bank, which is what ALE-25's "three recorded
 * playthroughs" is made of — one talked the yard down, one drew and someone died, one never drew
 * at all. Different stories through the same loop, so a regression that only shows up in combat,
 * or only in dialogue, has somewhere to fail.
 *
 * `intents` and `tools` are separate on purpose. In the M1 recording the game master **never
 * swung**: the player drew on Halloran and the model answered by opening the gate, moving the
 * guard aside, advancing the quest and talking the yard down. Requiring the model to attack would
 * be requiring it to play badly, and a test that demands a particular story is a test of the
 * story, not of the loop. What must be true is that the encounter really ran through the engine —
 * an `attack` intent with a verdict, `end_turn` passing initiative to an NPC the game master then
 * played — and that is what the two lists say.
 */
interface Playthrough {
  file: string;
  /** What the player is trying to do on each turn. The shape of the story, not the moves. */
  beats: Beat[];
  /** Intent kinds the recording must contain, whoever asked for them. */
  intents: readonly string[];
  /** GM tool names the recording must contain. */
  tools: readonly string[];
  /** Player turns the committed recording contains, checked when it is replayed. */
  playerTurns: number;
  /**
   * This session is also held to the M4 gate (ALE-48): it must contain a location authored
   * mid-session that the player walked into and back out of. Only `beyond-the-lane` sets it; the
   * three M1/M3 scripts predate anywhere to walk to.
   */
  m4?: true;
}

function assertAcceptance(lines: RecordingLine[], play: Playthrough): void {
  const header = lines[0] as RecordingHeader;
  expect(header.line).toBe('header');
  const turns = lines.filter((l): l is RecordedTurn => l.line === 'turn');
  expect(turns.length).toBeGreaterThan(0);

  // ---- 1. zero direct state edits: the hash chain has no gaps -------------------------------
  let previous = header.hash;
  for (const turn of turns) {
    expect(turn.hashBefore).toBe(previous);
    previous = turn.hashAfter;
  }

  // ---- 2. every GM mutation carries an engine verdict ----------------------------------------
  const gmTurns = turns.filter((t) => t.toolCalls.length > 0);
  expect(gmTurns.length).toBeGreaterThan(0);
  for (const turn of turns) {
    expect(typeof turn.verdict.ok).toBe('boolean');
    for (const call of turn.toolCalls) {
      expect(call.verdict, `${call.name} was recorded without a verdict`).toBeDefined();
      expect(call.verdict.ok).toBe(turn.verdict.ok);
      if (!call.verdict.ok) expect(call.verdict.reason).toBeTruthy();
    }
    // A rejection changed nothing. The engine's contract, checked in the evidence.
    if (!turn.verdict.ok) {
      expect(turn.diffs).toEqual([]);
      expect(turn.hashAfter).toBe(turn.hashBefore);
    }
  }

  // Rejections are recorded too. Without this the evidence could not show the world saying no,
  // and a game master that tried something illegal would leave no trace.
  const rejected = gmTurns.filter((t) => !t.verdict.ok);
  expect(rejected.length, 'no rejected GM mutation in the recording').toBeGreaterThan(0);
  for (const turn of rejected) expect(turn.verdict.reason).toBeTruthy();

  // Every mutation the engine saw, whoever asked for it.
  const intents = new Set(turns.map((t) => t.intent.kind));
  for (const kind of play.intents) expect([...intents]).toContain(kind);
  // And the subset the game master asked for through `POST /gm/tool`.
  const tools = new Set(gmTurns.flatMap((t) => t.toolCalls.map((c) => c.name)));
  for (const tool of play.tools) expect([...tools]).toContain(tool);
  // Where the script draws a sword, the encounter really ran: an `attack` the engine accepted.
  if (play.intents.includes('attack'))
    expect(turns.some((t) => t.intent.kind === 'attack' && t.verdict.ok)).toBe(true);

  // The player's own turns. Player commits are the ones with no tool call behind them.
  const playerCommits = turns.filter((t) => t.toolCalls.length === 0 && t.verdict.ok);
  expect(playerCommits.length).toBeGreaterThanOrEqual(play.playerTurns);

  // ---- 3. the recording replays to identical hashes -------------------------------------------
  const report = replay(lines, createEngine);
  expect(report.divergence?.reason ?? 'ok').toBe('ok');
  expect(report.ok).toBe(true);
  expect(report.turns).toBe(turns.length);
  expect(report.finalHash).toBe(report.recordedHash);
  expect(report.finalHash).toBe(previous);
}

/**
 * ALE-48, read out of the recording rather than out of the code that wrote it.
 *
 * `assertAcceptance` is the M1 claim — nothing edits state but the engine, every mutation carries
 * a verdict, the whole thing replays. This is the M4 claim on top of it: **the player walked into
 * a location that did not exist when the session started**, and every byte needed to walk there
 * again travels in the recording. Everything below is derived from the recorded `diffs`, which is
 * what `replay` re-derives from the recorded `intent`s — so a gate that passes here is a gate that
 * passes with no key, no network and no Python.
 *
 * Returns what it found, so the report can print it whether or not it asserted.
 */
interface M4Evidence {
  /** Maps written mid-session, in the order they were written. */
  authored: MapId[];
  /** Map ids the player set foot on, in order, starting with the one they started on. */
  visited: MapId[];
  /** Entities spawned onto ground that was authored mid-session. */
  settlers: { id: EntityId; map: MapId }[];
  /** Of those, the ones that went on to take a game master turn there. */
  stirred: EntityId[];
  /** Refusals the game master earned and then went on to succeed at the same tool. */
  recovered: { tool: string; reason: string }[];
  /** Dollars the turn that authored each location cost, from the recording's own meters. */
  usdPerLocation: number[];
  usdPerTurn: number;
}

function m4Evidence(lines: RecordingLine[]): M4Evidence {
  const header = lines[0] as RecordingHeader;
  const turns = lines.filter((l): l is RecordedTurn => l.line === 'turn');
  const meters = lines.filter((l): l is RecordedMeter => l.line === 'meter');
  const shipped = new Set(Object.keys(header.snapshot.world.maps));

  const authored: MapId[] = [];
  const authoredTurns = new Set<number>();
  const visited: MapId[] = [];
  const settlers: { id: EntityId; map: MapId }[] = [];
  const stirred = new Set<EntityId>();
  const recovered: { tool: string; reason: string }[] = [];
  const openRefusals = new Map<string, string>();
  // Where everyone is standing, folded forward from the header the same way `apply` folds it.
  const standing = new Map<EntityId, MapId>();
  for (const [id, entity] of Object.entries(header.snapshot.entities)) {
    const map = entity.components.position?.map;
    if (map) standing.set(id, map);
  }
  const playerStart = standing.get(PLAYER);
  if (playerStart) visited.push(playerStart);

  for (const turn of turns) {
    for (const call of turn.toolCalls) {
      if (!call.verdict.ok) openRefusals.set(call.name, call.verdict.reason ?? '');
      else {
        const earlier = openRefusals.get(call.name);
        if (earlier !== undefined) {
          recovered.push({ tool: call.name, reason: earlier });
          openRefusals.delete(call.name);
        }
      }
    }
    for (const diff of turn.diffs as Diff[]) {
      if (diff.type === 'MapAuthored' && !shipped.has(diff.map.id)) {
        authored.push(diff.map.id);
        authoredTurns.add(turn.turn);
      }
      if (diff.type === 'EntityTraversed') {
        standing.set(diff.entity, diff.toMap);
        if (diff.entity === PLAYER && visited.at(-1) !== diff.toMap) visited.push(diff.toMap);
      }
      if (diff.type === 'EntitySpawned') {
        const map = diff.entity.components.position?.map;
        if (map) {
          standing.set(diff.entity.id, map);
          if (authored.includes(map)) settlers.push({ id: diff.entity.id, map });
        }
      }
    }
    // A turn the game master caused on behalf of somebody standing in an authored location. Out
    // of an encounter that is an ambient turn by definition: nothing else moves an NPC.
    //
    // `spawn` is excluded, and the exclusion is the whole point of the measurement: putting
    // somebody on a map is not that person doing anything, and counting it would let a settler
    // who stood mute for the rest of the session read as one who acted.
    for (const call of turn.toolCalls) {
      if (!call.verdict.ok || call.name === 'spawn') continue;
      for (const id of settlers.map((s) => s.id)) {
        if (Object.values(call.args).includes(id) && authored.includes(standing.get(id) ?? ''))
          stirred.add(id);
      }
    }
  }

  // `RecordedTurn.turn` counts mutations and `RecordedMeter.turn` counts **player** turns, so the
  // two cannot be matched by number. A meter is written when a player turn has finished
  // resolving, so every mutation line belongs to the next meter that follows it in the file.
  const owner = new Map<number, number>();
  let waiting: number[] = [];
  for (const line of lines) {
    if (line.line === 'turn') waiting.push(line.turn);
    else if (line.line === 'meter') {
      for (const t of waiting) owner.set(t, line.turn);
      waiting = [];
    }
  }
  const total = meters.reduce((a, m) => a + m.usd, 0);
  return {
    authored,
    visited,
    settlers,
    stirred: [...stirred],
    recovered,
    usdPerLocation: [...authoredTurns].map(
      (t) => meters.find((m) => m.turn === owner.get(t))?.usd ?? 0,
    ),
    usdPerTurn: meters.length ? total / meters.length : 0,
  };
}

/** The gate itself. Only the first two clauses are the exit criterion; the rest are reported. */
function assertM4Gate(lines: RecordingLine[]): M4Evidence {
  const found = m4Evidence(lines);
  // A location that did not exist when the session started...
  expect(found.authored.length, 'no map was authored in this session').toBeGreaterThan(0);
  // ...that the player walked into, and back out of.
  const walkedInto = found.visited.filter((m) => found.authored.includes(m));
  expect(
    walkedInto.length,
    `player never set foot on ${found.authored.join(', ')}`,
  ).toBeGreaterThan(0);
  expect(found.visited.at(-1), 'player never came back').toBe(found.visited[0]);
  // And the bytes to do it again travel in the recording: the authored map's whole `MapRecord` is
  // in a `MapAuthored` diff, which is what `apply` folds and `replay` re-derives. If it were not,
  // the replay in `assertAcceptance` could not have reached the same hash — this asserts it
  // directly anyway, because that is the bug ALE-21 already shipped once with `templates`.
  const written = lines
    .filter((l): l is RecordedTurn => l.line === 'turn')
    .flatMap((t) => (t.diffs as Diff[]).filter((d) => d.type === 'MapAuthored'));
  for (const diff of written) expect(diff.map.cells.length).toBe(diff.map.width * diff.map.height);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Suite 1 — the committed evidence, replayed. No credentials, no Python, runs in `check`.
// ---------------------------------------------------------------------------------------------

describe('the recorded playthroughs', () => {
  it.each(Object.keys(SCRIPTS))(
    '%s replays to identical hashes, with every GM mutation carrying a verdict',
    (name) => {
      const play = SCRIPTS[name]!;
      const lines = parseRecording(readFileSync(bankFile(play), 'utf8'));
      assertAcceptance(lines, play);
      // The M4 claim, re-checked out of the committed bytes on every push — no key, no network,
      // no Python. That is the whole exit criterion, and this is where it stops being a claim.
      if (play.m4) assertM4Gate(lines);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// The ten turns
// ---------------------------------------------------------------------------------------------

interface ScriptedTurn {
  intent: Intent;
  text?: string;
}

/**
 * One turn's worth of player intention.
 *
 * **The beats are fixed; the intents are not.** A first attempt at this hard-coded ten intents, and
 * it died on turn 5 against the live model with "(6, 5) is occupied." — the game master had walked
 * Halloran onto the tile the script was about to step on. That is not a flaw in the run, it is the
 * whole point of the milestone: the world moves between your decision and your next one. So each
 * turn is resolved against the **live snapshot** the way a UI resolves it, by offering the engine a
 * preference-ordered list of candidates and taking the first one it calls legal. That is
 * `legal_actions` by another name, and it is what keeps a ten-turn run reproducible without
 * pretending the game master will stand still.
 */
type Beat =
  /** Speak `line` to `to`; `text` is the free player text the game master is given. */
  | { do: 'say'; to: EntityId; line: string; text: string }
  /** Walk as far toward `target` as the rules allow. */
  | { do: 'approach'; target: EntityId }
  /** Swing at `target`; close the distance, or pass the turn, if that is not legal. */
  | { do: 'strike'; target: EntityId }
  /** Swing at whoever is in reach, else close, else pass the turn. */
  | { do: 'fight' }
  /**
   * Press **outward**, away from where the session started (ALE-48). Cross an outward door under
   * your feet; else walk toward this map's undefined edge; else walk toward an outward door.
   *
   * Standing *on* an undefined edge there is nothing left to walk to, so the beat becomes the
   * player saying what they are doing — and what they are doing is walking off the edge of the
   * written world. That is the only thing in this file that asks the game master to author, and it
   * asks by describing a player's intention rather than by naming a tool.
   */
  | { do: 'onward'; line: string; text: string }
  /** Stand still and speak. A quiet turn, which is what buys the world an ambient one. */
  | { do: 'linger'; line: string; text: string }
  /** Press **inward**, back the way you came. The same walk, with the ranking reversed. */
  | { do: 'homeward'; line: string; text: string };

const PLAYER: EntityId = 'player';

/**
 * The `spawn` templates the server boots the gatehouse with (`app.ts`), so the free policy suite's
 * stand-in game master can put somebody in the location it writes. Built here rather than imported
 * from `bank/generate.ts`, whose exports are the bank's business and whose bytes are evidence.
 */
const GATEHOUSE_TEMPLATES = Object.fromEntries(
  NPC_ARCHETYPES.map((npc) => [npc.archetype, npcEntity(npc)]),
);

const say = (to: EntityId, line: string, text: string): Beat => ({ do: 'say', to, line, text });
const onward = (line: string, text: string): Beat => ({ do: 'onward', line, text });
const linger = (line: string, text: string): Beat => ({ do: 'linger', line, text });
const homeward = (line: string, text: string): Beat => ({ do: 'homeward', line, text });

/**
 * The three committed playthroughs. Every one is ten player turns on the ALE-16 gatehouse against
 * the live `claude-opus-5`, and every one tells a different story, because a bank of three
 * recordings of the same story would only be the first recording weighed three times.
 */
const SCRIPTS: Record<string, Playthrough> = {
  /** ALE-17. Dialogue, then a drawn sword — and a game master that answered by opening the gate. */
  'm1-acceptance': {
    file: 'm1-acceptance.jsonl',
    beats: [
      say(
        GUARD_ID,
        'Hail the gate!',
        'I want to get a wounded man through this gate. Who do I talk to?',
      ),
      { do: 'approach', target: GUARD_ID },
      say(
        MERCHANT_ID,
        'Ilva, a word.',
        'I ask Ilva whether she will vouch for me with the warden.',
      ),
      { do: 'approach', target: GUARD_ID },
      say(
        GUARD_ID,
        'Warden, the watchword is burned. Brannoc is bleeding out in your yard.',
        'I tell Halloran the truth and ask him to open the gate for the scout.',
      ),
      { do: 'approach', target: GUARD_ID },
      { do: 'fight' },
      { do: 'fight' },
      { do: 'fight' },
      { do: 'fight' },
    ],
    intents: ['say', 'attack', 'set_disposition', 'end_turn'],
    tools: ['say', 'set_disposition', 'end_turn'],
    playerTurns: 10,
  },

  /**
   * ALE-25. The player crosses the yard and finishes the man they came to carry out of it.
   *
   * **Someone has to die here**, because no live session has ever produced a death and a death is
   * where damage, the `dead` condition, a corpse refusing to be hit and a game master reacting to
   * a killing all meet. Getting one cost two runs and about $5 to learn how, and the lesson is
   * that the target has to be chosen by arithmetic rather than by drama. The first two brawls went
   * after Ilva — 9 hp behind AC 11, which needs two landed hits — and both left her alive: the
   * player gets one swing every *other* beat at best, because a swing and the `end_turn` that
   * refreshes the action cannot share a turn, so ten beats buy three or four attacks, and three or
   * four attacks against 9 hp is a coin toss that came up tails twice. The game master also spent
   * both runs walking her out of reach, which is the world doing its job.
   *
   * Brannoc is 4 hp behind AC 12 and **prone**, so a melee swing has advantage and any landed hit
   * is lethal. One hit, not two, and a prone man is not walking anywhere. The eight strike beats
   * are what is left after two beats of crossing the yard; once he is down they fall through to
   * whoever else is in reach, which is how the rest of the yard gets drawn in.
   */
  'yard-brawl': {
    file: 'yard-brawl.jsonl',
    beats: [
      { do: 'approach', target: SCOUT_ID },
      { do: 'approach', target: SCOUT_ID },
      { do: 'strike', target: SCOUT_ID },
      { do: 'strike', target: SCOUT_ID },
      { do: 'strike', target: SCOUT_ID },
      { do: 'strike', target: SCOUT_ID },
      { do: 'strike', target: SCOUT_ID },
      { do: 'strike', target: SCOUT_ID },
      { do: 'strike', target: SCOUT_ID },
      { do: 'strike', target: SCOUT_ID },
    ],
    intents: ['say', 'move', 'attack', 'end_turn'],
    tools: ['say'],
    playerTurns: 10,
  },

  /**
   * ALE-25. The sword never leaves the scabbard. The player tends Brannoc, gets the name out of
   * him, buys linen and a character reference from Ilva, and then works on the warden — which is
   * the quest as it is actually written (`carry-the-scout`: find out who cut Brannoc open, get him
   * through the gate, tell the garrison the watchword is burned). No encounter ever starts, so
   * this is the one recording in which the game master is doing nothing but talk, remember and
   * move the world's flags and quest steps.
   */
  parley: {
    file: 'parley.jsonl',
    beats: [
      say(
        SCOUT_ID,
        'Brannoc. Lie still — I have you.',
        'I kneel beside Brannoc, press the wound shut with my cloak, and ask him who cut him open.',
      ),
      { do: 'approach', target: SCOUT_ID },
      say(
        SCOUT_ID,
        'Give me the name. Say it once and I will carry it through that gate myself.',
        'I ask Brannoc for the name of the man who cut him, and for the watchword, and promise to carry both to the garrison.',
      ),
      say(
        MERCHANT_ID,
        'Ilva. There is bandage linen in that pack. Name your price.',
        'I offer Ilva all twenty-five coin for linen, and ask her to tell the warden I am no deserter.',
      ),
      { do: 'approach', target: GUARD_ID },
      say(
        GUARD_ID,
        'Warden Halloran. The watchword is burned. Brannoc carried it and Brannoc is opened up in your yard.',
        'I tell Halloran the watchword is compromised, name who cut Brannoc, and ask him to open the gate for a wounded man.',
      ),
      say(
        GUARD_ID,
        'Ilva will vouch for me. Brannoc gave me the name. Open the gate.',
        'I ask Halloran to let me carry Brannoc through, and offer to stand surety for him myself.',
      ),
      { do: 'approach', target: GUARD_ID },
      say(
        GUARD_ID,
        'Then send a runner to your captain with the name. I will wait on this side of it.',
        'I hand Halloran the name and ask him to send it up the chain while I carry Brannoc in.',
      ),
      say(
        GUARD_ID,
        'Warden. He is dying while we talk.',
        'I ask Halloran one last time to open the gate for Brannoc.',
      ),
    ],
    intents: ['say', 'move'],
    tools: ['say'],
    playerTurns: 10,
  },

  /**
   * ALE-48. **The M4 gate**: a player walks into a location that did not exist when the session
   * started, and the recording of it replays hash-for-hash with no key, no network and no Python.
   *
   * The other three scripts never leave the yard, because until M4 there was nowhere else. This
   * one is the only one that crosses a map boundary at all, and it crosses four: out of the
   * gatehouse into the lane (ALE-43), off the end of the written world into whatever the game
   * master writes there (ALE-44), and the same two back. Every beat is resolved against the live
   * snapshot like the others, which is what lets a script name a map whose id nothing knew when
   * the script was written — `onward` is a *direction*, not an itinerary.
   *
   * The five seams the issue asks about, and where each one is exercised:
   *
   * 1. Authoring through the frontier **transitions** created — beats 4-6: the edge the lane
   *    carries is only reachable because `traverse` exists, and the door out of the authored map
   *    is one the engine wrote, not one the model described.
   * 2. An authored map's NPCs taking **ambient** turns — beats 7-9 linger there, which is what an
   *    ambient turn costs. Whether anybody is there to take one is the game master's choice, made
   *    with `spawn`; `assertM4Gate` is what says whether it made it.
   * 3. **Scoping** across the grown world — measured by `count_tokens` in `services/gm`, not here.
   * 4. A **refusal recovered from** — not scripted, because a scripted refusal is the unit test
   *    that already exists. Reported out of the recording, earned or not.
   * 5. The **recording** carrying all of it — `assertAcceptance` plus `assertM4Gate`.
   */
  'beyond-the-lane': {
    file: 'beyond-the-lane.jsonl',
    beats: [
      onward(
        'The postern, then.',
        'I have left Brannoc with Ilva. I make for the postern at the bottom of the yard.',
      ),
      onward('Through.', 'I go through the postern and out into the lane.'),
      onward('East.', 'I walk east along the lane, away from the gate.'),
      onward(
        'Keep on.',
        'I keep on east, to where the lane turns out of sight past the spoil heap.',
      ),
      onward(
        'What is past the heap?',
        'I am standing at the turn of the lane, where it runs on east out of sight. ' +
          'I walk on, past the spoil heap, to see what is beyond it and who is there.',
      ),
      onward('On, then.', 'I go on into it, and look about me.'),
      onward('Further in.', 'I go further in, and see what else is here, and who.'),
      linger(
        'Who is here?',
        'I stand still and take in this place — what is in it, and who is in it with me.',
      ),
      linger(
        'Anyone there?',
        'I call out, once, to whoever shares this place with me, and wait to be answered.',
      ),
      homeward('Back to the way in.', 'I turn back the way I came, toward the way out.'),
      homeward('Through.', 'I go back through into the lane.'),
      homeward('West.', 'I turn west along the lane, toward the postern.'),
      homeward('Keep west.', 'I keep west along the lane, toward the postern.'),
      homeward('Home.', 'I go back through the postern into the gatehouse yard.'),
      homeward('In the yard again.', 'I am back in the yard, and I look for Brannoc and Ilva.'),
    ],
    // `author_map` is the one that did not exist in M3, and `traverse` is what makes it reachable.
    intents: ['move', 'traverse', 'author_map', 'say'],
    tools: ['author_map'],
    playerTurns: 15,
    m4: true,
  },
};

function positionOf(snapshot: Snapshot, id: EntityId): { x: number; y: number } | null {
  const p = snapshot.entities[id]?.components.position;
  return p ? { x: p.x, y: p.y } : null;
}

/** Which map an entity stands on, or `null`. Every entity has carried this since ALE-8. */
function mapOf(snapshot: Snapshot, id: EntityId): MapId | null {
  return snapshot.entities[id]?.components.position?.map ?? null;
}

/**
 * The board the player is actually standing on.
 *
 * Until ALE-43 this was `Object.values(world.maps)[0]`, because there was only ever one map and
 * the first one was it. With a world that grows, "the first map ever loaded" and "the map the
 * player is on" are different places, and every move candidate has to be composed on the second.
 */
function playerMap(snapshot: Snapshot): MapRecord | undefined {
  const on = mapOf(snapshot, PLAYER);
  return on ? snapshot.world.maps[on] : undefined;
}

/**
 * How far from home a map is: its position in the order the world loaded them.
 *
 * The gatehouse is index 0 because the session started in it, the lane is 1 because it ships
 * loaded beside it, and anything the game master writes is appended after both — `author_map`
 * calls `setMap` on the new map before it re-sets the one whose edge it consumed, and re-setting
 * an existing key does not move it. So "outward" is simply "a higher index than the one I am
 * standing on", which is a direction a script can name without knowing a single map id.
 */
function outwardness(snapshot: Snapshot, id: MapId | null): number {
  return id === null ? -1 : Object.keys(snapshot.world.maps).indexOf(id);
}

function sameTile(a: Tile, b: { x: number; y: number }): boolean {
  return a.x === b.x && a.y === b.y;
}

/** The nearest of `tiles` to the player, or `null` when there are none. */
function nearestTo(from: { x: number; y: number } | null, tiles: Tile[]): Tile | null {
  if (!from || tiles.length === 0) return null;
  return [...tiles].sort((a, b) => chebyshev(from, a) - chebyshev(from, b))[0]!;
}

/**
 * The move candidates for a **journey**, best first, ordered by how many steps each tile leaves
 * between it and the goal — the engine's own `path()`, not the straight-line distance.
 *
 * `tilesToward` sorts on chebyshev, which is the right answer in an open yard and the wrong one in
 * a corridor: the postern lane doubles back on itself, so the tile that *looks* five closer to the
 * lane's far end can be eleven steps away round the wall, and a player who takes it spends the
 * turn going nowhere. That is why the first draft of `beyond-the-lane` needed three turns to walk
 * a twelve-tile lane and came home two beats short. Ordered on real path length the same walk is
 * two turns, which is what the character's speed says it should be.
 *
 * It is a separate function rather than a fix to `tilesToward` on purpose: the three gatehouse
 * scripts choose their moves with that one, and re-ordering their candidates would quietly change
 * what three committed recordings were played from.
 */
function tilesAlong(snapshot: Snapshot, goal: Tile): Intent[] {
  const map = playerMap(snapshot);
  if (!map) return [];
  const budget = map.width * map.height;
  const out: { to: Tile; cost: number }[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const to = { x, y };
      const cost = sameTile(to, goal) ? 0 : (path(map, to, goal, budget)?.length ?? Infinity);
      if (Number.isFinite(cost)) out.push({ to, cost });
    }
  }
  return out
    .sort((a, b) => a.cost - b.cost)
    .map(({ to }) => ({ kind: 'move', entity: PLAYER, to }) satisfies Intent);
}

function chebyshev(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Alive entities the game master plays **on the player's map**, nearest first. Who the player can
 * talk to, or hit.
 *
 * The map filter is new with ALE-48 and is a no-op for the three gatehouse scripts, where nobody
 * ever leaves the yard. It matters the moment the player walks through a door: a capsule on
 * another board is not somebody you can speak to, and chebyshev distance between two tiles that
 * mean different places is not a distance at all.
 */
function gmEntities(snapshot: Snapshot): EntityId[] {
  const me = positionOf(snapshot, PLAYER);
  const here = mapOf(snapshot, PLAYER);
  return Object.values(snapshot.entities)
    .filter(
      (e) =>
        e.components.brain?.policy === GM_BRAIN_POLICY &&
        !e.components.health?.conditions.includes('dead') &&
        e.components.position &&
        e.components.position.map === here,
    )
    .sort((a, b) => {
      if (!me) return 0;
      const pa = positionOf(snapshot, a.id)!;
      const pb = positionOf(snapshot, b.id)!;
      return chebyshev(me, pa) - chebyshev(me, pb);
    })
    .map((e) => e.id);
}

/**
 * Every tile on the map, ordered by how close it is to `goal` — the move candidates, best first.
 * Which of them are walkable, unoccupied and inside this turn's movement is the engine's answer,
 * not this function's, so the player simply walks as far toward the gate as the rules allow.
 */
function tilesToward(snapshot: Snapshot, goal: { x: number; y: number }): Intent[] {
  const map = playerMap(snapshot);
  if (!map) return [];
  const tiles: { x: number; y: number }[] = [];
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) tiles.push({ x, y });
  return tiles
    .sort((a, b) => chebyshev(a, goal) - chebyshev(b, goal))
    .map((to) => ({ kind: 'move', entity: PLAYER, to }) satisfies Intent);
}

/** Candidates for one beat, best first. The engine picks; this only says what the player wants. */
function candidates(beat: Beat, snapshot: Snapshot): Intent[] {
  const nearby = gmEntities(snapshot);
  const me = positionOf(snapshot, PLAYER);
  const speak = (to: EntityId | null, text: string): Intent => ({
    kind: 'say',
    speaker: PLAYER,
    text,
    to,
  });
  const swing = (id: EntityId): Intent => ({
    kind: 'attack',
    attacker: PLAYER,
    target: id,
    ability: 'longsword',
  });
  const toward = (id: EntityId | undefined): Intent[] => {
    const goal = id ? positionOf(snapshot, id) : null;
    return goal ? tilesToward(snapshot, goal) : [];
  };
  // Something the player can always do, so a turn never fails to commit: speaking needs only a
  // living speaker, and the engine has never refused it for anything else.
  const fallback: Intent[] = [
    ...nearby.map((id) => speak(id, 'I am still here, and the scout is still bleeding.')),
    speak(null, 'I am still here, and the scout is still bleeding.'),
  ];

  if (beat.do === 'say') {
    return snapshot.entities[beat.to] ? [speak(beat.to, beat.line), ...fallback] : fallback;
  }
  if (beat.do === 'linger') return [speak(null, beat.line), ...fallback];
  if (beat.do === 'onward' || beat.do === 'homeward') {
    // A door leads outward when the map behind it loaded after the one you are standing on, and
    // inward when it loaded before. One comparison, both directions.
    const here = mapOf(snapshot, PLAYER);
    const rank = outwardness(snapshot, here);
    const wanted = (to: MapId): boolean =>
      beat.do === 'onward' ? outwardness(snapshot, to) > rank : outwardness(snapshot, to) < rank;
    const map = playerMap(snapshot);
    const doors = (map?.exits ?? []).filter((e) => wanted(e.to));
    const cross = (to: MapId): Intent => ({ kind: 'traverse', entity: PLAYER, to });
    // 1. A door under your feet, going the way you are going. Take it.
    const under = me ? doors.find((e) => sameTile(e.at, me)) : undefined;
    if (under) return [cross(under.to), speak(null, beat.line), ...fallback];
    // 2. Outward only: the undefined edge. Walk to it — and once you are on it there is nothing
    //    left to walk to, so all that is left is to say you are walking off the end of the world.
    //    That sentence is the whole ask; the game master is never told to call anything.
    const edge =
      beat.do === 'onward'
        ? nearestTo(
            me,
            (map?.frontiers ?? []).map((f) => f.at),
          )
        : null;
    if (edge && me && sameTile(edge, me)) return [speak(null, beat.line), ...fallback];
    // 3. Otherwise head for whichever is nearer: the edge, or a door going your way.
    const goal = nearestTo(me, [...(edge ? [edge] : []), ...doors.map((e) => e.at)]);
    return goal
      ? [...tilesAlong(snapshot, goal), speak(null, beat.line), ...fallback]
      : [speak(null, beat.line), ...fallback];
  }
  if (beat.do === 'approach') {
    // A target the game master has since killed or never had: fall back to whoever is nearest.
    const target = nearby.includes(beat.target) ? beat.target : nearby[0];
    return [...toward(target), ...fallback];
  }
  // A swing, at a named target or at whoever is in reach. When the swing is refused there are two
  // ways out — close the distance, or pass the turn — and which comes first is the difference
  // between a fight and a shuffle. The first `yard-brawl` run closed first and cost $2.59 to
  // learn why: the player hit Ilva once, spent its action, and then had *movement* left, so every
  // later beat took a step instead of ending the turn. The turn never passed, the action never
  // came back, and ten turns of a brawl contained exactly one sword swing.
  //
  // So the order depends on why the swing failed. Already in reach means the action is what is
  // missing, and only ending the turn brings it back. Out of reach means the distance is what is
  // missing, and ending the turn would just hand the game master another free move. Out of combat
  // `end_turn` is refused ("no encounter is running"), so both orders walk.
  const adjacent = me ? nearby.filter((id) => chebyshev(me, positionOf(snapshot, id)!) <= 1) : [];
  const hunted = beat.do === 'strike' && nearby.includes(beat.target) ? beat.target : undefined;
  const targets = [...(hunted ? [hunted] : []), ...adjacent.filter((id) => id !== hunted)];
  const pass: Intent = { kind: 'end_turn', entity: PLAYER };
  const close = toward(hunted ?? targets[0] ?? nearby[0]);
  const inReach = hunted ? adjacent.includes(hunted) : targets.length > 0;
  return [...targets.map(swing), ...(inReach ? [pass, ...close] : [...close, pass]), ...fallback];
}

/**
 * The first candidate the engine accepts, resolved on a throwaway engine built from the live
 * snapshot. Exactly what a UI does when it greys out the actions you cannot take, and exactly what
 * preview does — the real engine is never asked, so choosing costs the world nothing.
 */
function choose(beat: Beat, snapshot: Snapshot): ScriptedTurn {
  for (const intent of candidates(beat, snapshot)) {
    const probe = createEngine(structuredClone(snapshot), { seed: GATEHOUSE_SEED });
    if (probe.apply(intent).ok) {
      // The free player text rides on the turn whenever the beat carries one. For `say` it is
      // only attached when the intended line was the one that went through, because a fallback
      // mutter is not what that text describes. For the ALE-48 beats it always rides, because
      // there the text describes the *journey* — "I walk on east past the spoil heap" is true of
      // the step, the crossing and the standing still alike, and it is the only thing the game
      // master is ever given about where the player is trying to get to.
      if (beat.do === 'say')
        return intent.kind === 'say' && intent.to === beat.to
          ? { intent, text: beat.text }
          : { intent };
      if (beat.do === 'onward' || beat.do === 'homeward' || beat.do === 'linger')
        return { intent, text: beat.text };
      return { intent };
    }
  }
  throw new Error(`no legal intent for beat ${JSON.stringify(beat)}`);
}

// ---------------------------------------------------------------------------------------------
// Suite 1b — the policy itself, with no model in the loop. Free, and it runs in `check`.
// ---------------------------------------------------------------------------------------------

describe('the playthrough policy', () => {
  /**
   * The stand-in game master: it passes every NPC turn and does nothing else. It is here because
   * without it the first `attack` starts an encounter, initiative lands on Halloran, and every
   * later beat is refused with "it is not your turn" — the player would get exactly one swing in
   * ten turns and nobody could ever die. Passing the turn is the *least* a game master does, so
   * this is the floor: whatever the live model chooses to do on an NPC's turn, the player gets at
   * least these openings. It is not a substitute for the live runs, which are the only thing that
   * proves the loop works; it is here to catch the harness breaking — a beat with no legal
   * candidate, an approach that never arrives, a fight that cannot reach anybody — for free.
   */
  function passNpcTurns(engine: Engine): void {
    for (let guard = 0; guard < 16; guard++) {
      const init = engine.snapshot().initiative;
      const active = init?.order[init.current];
      if (!active || active === PLAYER) return;
      if (!engine.apply({ kind: 'end_turn', entity: active }).ok) return;
    }
  }

  /**
   * The stand-in's other half, for ALE-48: a game master that **writes one location**.
   *
   * `passNpcTurns` is the floor for a fight; this is the floor for a frontier. When the player is
   * standing on an undefined edge it authors the least interesting location that could be beyond
   * it and puts one person in it — which is exactly the pair of calls `beyond-the-lane` needs the
   * live model to make, through exactly the same validated door.
   *
   * It is not evidence that the model will do this; only the live run is that. It is evidence
   * that the **script** works: that the edge is reachable in the beats allowed, that the door the
   * engine writes is one `traverse` will take, that somebody spawned out there is somebody the
   * ambient cast can see, and that the way home is walkable. Two live runs were spent on
   * `yard-brawl` learning things a free suite could have told them; this is that lesson applied.
   */
  function authorAtFrontier(engine: Engine, played: Intent): boolean {
    const snapshot = engine.snapshot();
    const me = positionOf(snapshot, PLAYER);
    const on = mapOf(snapshot, PLAYER);
    const edge = (playerMap(snapshot)?.frontiers ?? []).find((f) => me && sameTile(f.at, me));
    // The same trigger the live run relies on: the player standing on the undefined edge and
    // *saying* they are walking off it. Arriving there is not the ask — a player may stand on a
    // road end and turn round — so a turn spent walking onto the tile authors nothing.
    if (!edge || !on || !me || played.kind !== 'say') return false;
    // One location, not one per quiet turn. The stand-in is the floor for the script, and a
    // second `author_map` with the same id would be refused anyway; what the live model does with
    // the edges it writes for itself is its own business and the script survives either way.
    if (snapshot.world.maps['stand-in-rise']) return false;
    const verdict = engine.apply({
      kind: 'author_map',
      id: 'stand-in-rise',
      width: 8,
      height: 6,
      terrain: ['########', '#......#', '#......#', '#......#', '#......#', '########'],
      back: { at: { x: 1, y: 3 }, to: on, arrive: { x: me.x, y: me.y }, label: 'the lane back' },
      frontiers: [{ at: { x: 6, y: 1 }, label: 'the slope going on up' }],
      objectives: [{ at: { x: 6, y: 4 }, note: 'a drag-trail in the spoil', quest: null }],
    });
    expect(verdict.ok, `author_map: ${verdict.reason ?? ''}`).toBe(true);
    return true;
  }

  /**
   * Somebody for the ambient cast to find. `author_map` writes terrain only (decision 4 of
   * `docs/m4-swarm.md`), so populating a new place is a second, separately validated call — and
   * this is the free proof that the pair composes: `spawn` onto a map that did not exist when the
   * engine's template table was built.
   */
  function populate(engine: Engine, mapId: MapId): void {
    const snapshot = engine.snapshot();
    if (!snapshot.world.maps[mapId] || snapshot.entities['stand-in-digger']) return;
    const verdict = engine.apply({
      kind: 'spawn',
      template: 'merchant',
      at: { x: 3, y: 3 },
      map: mapId,
      id: 'stand-in-digger',
    });
    expect(verdict.ok, `spawn: ${verdict.reason ?? ''}`).toBe(true);
  }

  function play(name: string): { kinds: string[]; snapshot: Snapshot } {
    const engine = createEngine(gatehouseSnapshot(), {
      seed: GATEHOUSE_SEED,
      templates: GATEHOUSE_TEMPLATES,
    });
    const kinds: string[] = [];
    for (const beat of SCRIPTS[name]!.beats) {
      passNpcTurns(engine);
      const { intent } = choose(beat, engine.snapshot());
      const verdict = engine.apply(intent);
      expect(verdict.ok, `${beat.do}: ${verdict.reason ?? ''}`).toBe(true);
      kinds.push(intent.kind);
      // The world's half of the turn, **after** the player's — the order the server resolves in,
      // where the game master answers what the player just did. Authoring a beat later than this
      // is what the extra `onward` beats are slack for.
      if (authorAtFrontier(engine, intent)) populate(engine, 'stand-in-rise');
    }
    return { kinds, snapshot: engine.snapshot() };
  }

  it.each(Object.keys(SCRIPTS))('%s finds a legal intent for every beat', (name) => {
    expect(play(name).kinds).toHaveLength(SCRIPTS[name]!.beats.length);
  });

  it('m1-acceptance walks the player to the gate and starts a fight', () => {
    const { kinds, snapshot } = play('m1-acceptance');
    expect(kinds).toContain('say');
    expect(kinds).toContain('move');
    // The encounter has to start, or the game master never takes an NPC turn and `attack` and
    // `end_turn` never appear in the evidence at all.
    expect(kinds).toContain('attack');
    expect(snapshot.initiative).not.toBeNull();
  });

  it('yard-brawl kills the scout, with a game master that only passes the turn', () => {
    // The script's whole reason to exist is a death, so the death is checked here, for free,
    // before any money is spent finding out that the player could not reach him or could not
    // swing often enough. Two live runs were spent learning exactly that.
    const { kinds, snapshot } = play('yard-brawl');
    expect(kinds).toContain('attack');
    expect(snapshot.entities[SCOUT_ID]?.components.health?.conditions).toContain('dead');
  });

  it('parley never draws the sword', () => {
    const { kinds, snapshot } = play('parley');
    expect(kinds).not.toContain('attack');
    expect(kinds).toContain('say');
    expect(kinds).toContain('move');
    // No encounter at all: this is the recording in which the game master only ever talks.
    expect(snapshot.initiative).toBeNull();
  });

  it('beyond-the-lane walks off the edge of the world and comes home (ALE-48)', () => {
    const { kinds, snapshot } = play('beyond-the-lane');
    // The journey out and back: four crossings, at least one of them onto ground that did not
    // exist when the engine was built.
    expect(kinds.filter((k) => k === 'traverse')).toHaveLength(4);
    expect(kinds).toContain('move');
    // Three maps loaded where the scene shipped two, and the third is the one nobody wrote.
    expect(Object.keys(snapshot.world.maps)).toContain('stand-in-rise');
    // Home again, on the map the session started on, with the story intact.
    expect(mapOf(snapshot, PLAYER)).toBe('m1-gatehouse');
    expect(snapshot.initiative).toBeNull();
    // Somebody is standing in the authored location — ambient's cast, in the place that was
    // written for them. Who they are is the live game master's business; that there can be one
    // at all is this suite's.
    expect(snapshot.entities['stand-in-digger']?.components.position?.map).toBe('stand-in-rise');
    // The edge was consumed: a frontier is a place to write once, not a door that keeps opening.
    expect(snapshot.world.maps['m1-postern-lane']?.frontiers ?? []).toHaveLength(0);
  });

  it('the ambient cast finds somebody the engine never shipped, on a map nobody wrote', () => {
    // Seam 2 of ALE-48, made free and deterministic. The live run is what says whether the model
    // spawns anyone out there; this is what says that if it does, the machinery that gives them a
    // turn can see them. `ambientCandidates` filters on the *player's* map, so an NPC on ground
    // authored mid-session is a candidate only if authoring, spawning and the vicinity bound all
    // agree about where everybody is standing — three agents' work meeting in one predicate.
    const { snapshot } = play('beyond-the-lane');
    const there = structuredClone(snapshot);
    const player = there.entities[PLAYER]!.components.position!;
    player.map = 'stand-in-rise';
    player.x = 1;
    player.y = 3;
    const cast = ambientCandidates(there, new Map());
    expect(cast.map((c) => c.entity)).toEqual(['stand-in-digger']);
    // Nobody in the yard is a candidate any more: three maps away is not the player's scene.
    expect(cast.some((c) => c.entity === GUARD_ID)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Suite 2 — the live playthrough. Skipped without a key; CI has none.
// ---------------------------------------------------------------------------------------------

const live = Boolean(process.env['ANTHROPIC_API_KEY'] ?? process.env['ANTHROPIC_AUTH_TOKEN']);

/**
 * Which playthrough the live run plays, and how much of it.
 *
 *   source ~/.deliberate-env
 *   DELIBERATE_SCRIPT=yard-brawl DELIBERATE_WRITE_FIXTURE=1 \
 *     pnpm --filter @deliberate/server test -- acceptance
 *
 * `DELIBERATE_WRITE_FIXTURE` copies the recording the server wrote into `recordings/bank/` under
 * the script's own name, which is how a live entry is added (docs/regression-bank.md). It costs
 * roughly $2 and half an hour, so commit the bytes before doing anything else with them.
 */
const SCRIPT = process.env['DELIBERATE_SCRIPT'] ?? 'm1-acceptance';
const PLAY = SCRIPTS[SCRIPT] ?? SCRIPTS['m1-acceptance']!;
const TURNS = PLAY.beats.slice(0, Number(process.env['DELIBERATE_TURNS'] ?? PLAY.beats.length));

/**
 * Phase budgets for the live run. The blueprint targets preview <= 8 s and resolve <= 6 s; a real
 * `claude-opus-5` turn with adaptive thinking and up to eight tool steps does not fit that today,
 * and a budget that always aborts would measure nothing. These are the ceilings the run is given;
 * what it actually took is printed at the end and belongs in the PR.
 */
const PREVIEW_MS = Number(process.env['DELIBERATE_PREVIEW_MS'] ?? 120_000);
const RESOLVE_MS = Number(process.env['DELIBERATE_RESOLVE_MS'] ?? 120_000);
const NARRATE_MS = Number(process.env['DELIBERATE_NARRATE_MS'] ?? 90_000);

describe.skipIf(!live)(`${SCRIPT}: a ten-turn playthrough against the live model`, () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let gmProcess: ChildProcess | null = null;
  let recordingsDir: string;
  let nodeUrl = '';
  const usage: { phase: string; usage: Record<string, number> }[] = [];
  const timings: { turn: number; previewMs: number; goMs: number; afterGoMs: number }[] = [];

  beforeAll(async () => {
    const [nodePort, gmPort] = [await freePort(), await freePort()];
    nodeUrl = `http://127.0.0.1:${nodePort}`;
    // A live run is roughly $2 and half an hour, so where its bytes land is not a detail:
    // `DELIBERATE_RECORDINGS` puts them somewhere durable, and the temp dir is only the default
    // for a smoke test nobody wants to keep.
    recordingsDir =
      process.env['DELIBERATE_RECORDINGS'] ?? mkdtempSync(join(tmpdir(), 'deliberate-live-'));

    const inner = httpGmService({
      baseUrl: `http://127.0.0.1:${gmPort}`,
      timeoutMs: Math.max(PREVIEW_MS, RESOLVE_MS, NARRATE_MS),
    });
    // Tallies what the turn cost. The loop does not need `usage`, so it drops it; the acceptance
    // run is the one caller that has to report a price per turn.
    const gm: GmService = {
      // Policies (ALE-37) pass straight through: the run is judged on what reached the engine,
      // and a policy reaches it through the same door with the same verdicts.
      ...(inner.policy ? { policy: inner.policy.bind(inner) } : {}),
      async turn(request, options): Promise<GmTurnResponse> {
        const response = await inner.turn(request, options);
        usage.push({ phase: request.phase, usage: response.usage ?? {} });
        return response;
      },
    };

    app = await buildApp({
      scene: 'gatehouse',
      recordings: recordingsDir,
      gm,
      budgets: { preview: PREVIEW_MS, resolve: RESOLVE_MS, narrate: NARRATE_MS },
    });
    await app.listen({ port: nodePort, host: '127.0.0.1' });

    gmProcess = spawn(
      join(repoRoot, 'services/gm/.venv/bin/python'),
      ['-m', 'uvicorn', 'deliberate_gm.app:app', '--host', '127.0.0.1', '--port', String(gmPort)],
      {
        cwd: join(repoRoot, 'services/gm'),
        env: { ...process.env, GM_ENGINE_URL: `http://127.0.0.1:${nodePort}` },
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    await waitForHealth(`http://127.0.0.1:${gmPort}/healthz`);
  }, 120_000);

  afterAll(async () => {
    gmProcess?.kill('SIGTERM');
    await app?.close();
    if (!process.env['DELIBERATE_KEEP_RECORDING'] && !process.env['DELIBERATE_RECORDINGS'])
      rmSync(recordingsDir, { recursive: true, force: true });
  });

  it(
    'plays ten turns, records every GM mutation with its verdict, and replays to identical hashes',
    async () => {
      const path = app.recording!.path;
      const client = await connect(app);
      client.send({ type: 'join', room: app.room.id, protocol: PROTOCOL_VERSION });
      expect((await client.next()).type).toBe('snapshot');

      for (const [index, beat] of TURNS.entries()) {
        const turn = app.room.turn();
        expect(turn).toBe(index);

        const hashBeforePreview = app.room.engine.hash();
        // Composed against the world as it is now, not as it was when this file was written.
        const scripted = choose(beat, app.room.engine.snapshot());
        const previewAt = Date.now();
        client.send({
          type: 'preview_request',
          room: app.room.id,
          turn,
          intent: scripted.intent,
          ...(scripted.text ? { text: scripted.text } : {}),
        });
        const preview = await client.next(PREVIEW_MS + 30_000);
        expect(preview.type, `turn ${turn}: ${JSON.stringify(preview)}`).toBe('preview');
        const previewMs = Date.now() - previewAt;

        // Preview must not have moved the world, however much the game master did to the clone.
        // The clone is the mechanism (ALE-32); this is the check that it held on a live turn.
        expect(app.room.engine.hash(), `turn ${turn}: preview mutated the real engine`).toBe(
          hashBeforePreview,
        );

        const goAt = Date.now();
        client.send({ type: 'go', room: app.room.id, turn });
        // GO's own work — re-validating the player's intent on the real engine — is synchronous.
        // Everything after it is the game master resolving NPC turns and narrating.
        await waitUntil(() => app.room.turn() === turn + 1, RESOLVE_MS + NARRATE_MS + 60_000);
        const goMs = Date.now() - goAt;
        await app.gm.idle();
        await app.gm.idle();
        const afterGoMs = Date.now() - goAt;
        timings.push({ turn, previewMs, goMs, afterGoMs });
      }

      await client.close();
      expect(app.room.turn()).toBe(TURNS.length);

      // --- the refused mutation -----------------------------------------------------------
      // Ten turns of a well-behaved game master need not contain an illegal move, and the claim
      // that a refusal reaches the recording must not rest on the model misbehaving. So one
      // deliberately illegal call goes through the very same `POST /gm/tool` door the Python
      // service uses, naming a speaker who is not in the world. The engine refuses it, the
      // refusal lands in the recording beside its reason, and nothing moved — which is the claim.
      // How many refusals the model earned on its own is reported below, not asserted.
      const beforeRefusal = app.room.engine.hash();
      const refused = await fetch(`${nodeUrl}/gm/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session: app.room.id,
          turn: app.room.turn(),
          engine_token: 'live',
          call_id: 'ale17-illegal',
          tool: 'say',
          input: { npc_id: 'nobody', text: 'I am not here.', to: null },
        }),
      });
      const verdict = (await refused.json()) as { ok: boolean; reason: string | null };
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBeTruthy();
      expect(app.room.engine.hash()).toBe(beforeRefusal);

      const finalHash = app.room.engine.hash();
      // Read before the app closes: the skill cache is in memory, and the recording carries what
      // the policies *did* rather than how many turns they took (ALE-37).
      const caches = app.gm.cache();

      // The recording is only complete once the file is closed with the app.
      await app.close();
      if (process.env['DELIBERATE_WRITE_FIXTURE']) copyFileSync(path, bankFile(PLAY));

      const lines = parseRecording(readFileSync(path, 'utf8'));
      report(timings, usage, lines, caches);
      // Reported *before* it is asserted, and separately from it. A gate that fails has to say
      // what it found — where the player actually got to, what was written, who was standing in
      // it — or the run costs money and produces a stack trace instead of an answer.
      if (PLAY.m4) reportM4(m4Evidence(lines));
      assertAcceptance(lines, { ...PLAY, playerTurns: TURNS.length });
      if (PLAY.m4) assertM4Gate(lines);
      // The live engine and a fresh engine fed only the recorded intents agree, byte for byte.
      expect(replay(lines, createEngine).finalHash).toBe(finalHash);
    },
    30 * 60_000,
  );
});

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

function report(
  timings: { turn: number; previewMs: number; goMs: number; afterGoMs: number }[],
  usage: { phase: string; usage: Record<string, number> }[],
  lines: RecordingLine[],
  caches?: { preview: CacheStats; decisions: CacheStats; policies: CacheStats },
): void {
  const totals = usage.reduce(
    (acc, u) => {
      for (const [k, v] of Object.entries(u.usage)) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    },
    {} as Record<string, number>,
  );
  // The same prices and the same split the meters bill with (ALE-24), so the acceptance report
  // and the recording's own summary can never disagree about what a turn cost.
  const dollars = usdFor(tokensFrom(totals));
  const turns = timings.length || 1;
  const mean = (pick: (t: (typeof timings)[number]) => number): number =>
    Math.round(timings.reduce((a, t) => a + pick(t), 0) / turns);
  console.log(`\n--- ${SCRIPT}: ${timings.length}-turn playthrough ---`);
  console.table(timings);
  console.log(
    `preview mean ${mean((t) => t.previewMs)} ms | GO->turn mean ${mean((t) => t.goMs)} ms | ` +
      `GO->idle mean ${mean((t) => t.afterGoMs)} ms`,
  );
  console.log(`model calls ${usage.length} | tokens ${JSON.stringify(totals)}`);
  console.log(`$${dollars.toFixed(4)} total, $${(dollars / turns).toFixed(4)} per turn`);
  // And the same thing again, read back out of the recording the server wrote — which is what
  // `pnpm meters <file>` prints, and what M3's "p50 after GO < 10 s" is graded on (ALE-24).
  console.log(`\n--- meters, from the recording ---\n${formatSummary(summarize(lines))}`);
  const gm = lines.filter((l): l is RecordedTurn => l.line === 'turn' && l.toolCalls.length > 0);
  // Refusals the model earned on its own, as opposed to the one the test drove deliberately.
  const earned = gm.filter(
    (l) => !l.verdict.ok && l.toolCalls.every((c) => c.args['npc_id'] !== 'nobody'),
  );
  if (caches) {
    // ALE-37's number: NPC turns taken without a model call, over NPC turns taken at all.
    const skill = caches.policies.hits + caches.decisions.hits;
    const npcTurns = skill + caches.policies.misses;
    const rate = npcTurns ? ((skill / npcTurns) * 100).toFixed(0) : '0';
    console.log(
      `\nskill cache: ${caches.policies.hits} NPC turns from a policy, ` +
        `${caches.decisions.hits} from the decision cache, ${caches.policies.misses} asked ` +
        `of the model — ${rate}% served without a model call (${caches.policies.size} policies held)`,
    );
  }
  console.log(
    `recorded lines ${lines.length} | GM mutations ${gm.length} | ` +
      `refusals the model earned ${earned.length}` +
      (earned.length ? `: ${earned.map((l) => l.verdict.reason).join(' / ')}` : ''),
  );
}

/**
 * The M4 numbers ALE-48 asks to be reported rather than asserted: what the world looked like by
 * the end, and what it cost to grow it.
 *
 * Cost per **location** is the interesting one and it is not the same shape as cost per turn.
 * Authoring is expensive per call and amortised for ever after — decision 7 of `docs/m4-swarm.md`
 * — so a milestone that quietly turned a one-off cost into a per-turn one would show up here as
 * the two numbers converging, and nowhere else.
 */
function reportM4(found: M4Evidence): void {
  console.log(`\n--- M4 (ALE-48) ---`);
  console.log(`authored this session: ${found.authored.join(', ') || 'nothing'}`);
  console.log(`the player's road: ${found.visited.join(' -> ')}`);
  console.log(
    `spawned onto authored ground: ${
      found.settlers.map((s) => `${s.id} on ${s.map}`).join(', ') || 'nobody'
    }`,
  );
  console.log(`of those, took a turn there: ${found.stirred.join(', ') || 'nobody'}`);
  console.log(
    `refusals recovered from: ${
      found.recovered.map((r) => `${r.tool} ("${r.reason}")`).join(' / ') || 'none earned'
    }`,
  );
  const perLocation = found.usdPerLocation;
  console.log(
    `$${perLocation.map((u) => u.toFixed(4)).join(' + ')} per authored location | ` +
      `$${found.usdPerTurn.toFixed(4)} per turn`,
  );
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address !== 'string' ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

async function waitUntil(ready: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the turn to commit');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`the GM service never answered ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

interface ScriptedClient {
  send(frame: unknown): void;
  next(timeoutMs?: number): Promise<ServerMessage>;
  close(): Promise<void>;
}

/** Joins over a real socket: the acceptance run travels the protocol, not an in-process shortcut. */
async function connect(app: Awaited<ReturnType<typeof buildApp>>): Promise<ScriptedClient> {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  const queue: ServerMessage[] = [];
  const waiting: ((message: ServerMessage) => void)[] = [];
  ws.on('message', (data) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    // Narration and committed diffs are broadcast asynchronously; the driver waits on the frames
    // that answer what it sent, so they are dropped here rather than desynchronising the queue.
    if (message.type === 'narration' || message.type === 'diffs') return;
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else queue.push(message);
  });
  await new Promise<void>((done, fail) => {
    ws.once('open', () => done());
    ws.once('error', fail);
  });
  return {
    send: (frame) => ws.send(JSON.stringify(frame)),
    next: (timeoutMs = 30_000) => {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<ServerMessage>((done, fail) => {
        const timer = setTimeout(() => fail(new Error('timed out waiting for a frame')), timeoutMs);
        waiting.push((message) => {
          clearTimeout(timer);
          done(message);
        });
      });
    },
    close: () =>
      new Promise<void>((done) => {
        ws.once('close', () => done());
        ws.close();
      }),
  };
}
