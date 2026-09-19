import { PROTOCOL_VERSION, type ClientMessage, type Intent, type Tile } from '@deliberate/protocol';

/**
 * Wire validation for ALE-11. Nothing that arrives on a socket is trusted: a frame becomes a
 * `ClientMessage` only after every field it carries has been checked here, so the room and the
 * engine only ever see well-formed shapes. Failures come back as a reason a player could read.
 */

export type FrameResult = { ok: true; message: ClientMessage } | { ok: false; reason: string };

/** Longest id or ability key accepted off the wire; keeps a hostile client from sending novels. */
const MAX_ID_LENGTH = 128;

/**
 * Longest free player text accepted off the wire. It reaches the game master as quoted data rather
 * than instruction (ALE-33), but a bound still belongs here: the prompt has a token budget, and a
 * client that can send a novel can spend someone's money.
 */
const MAX_TEXT_LENGTH = 2_000;

function bad(reason: string): FrameResult {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isTile(value: unknown): value is Tile {
  return isRecord(value) && Number.isInteger(value['x']) && Number.isInteger(value['y']);
}

/**
 * The intents a **player** may compose. Legality is the engine's job; this only checks the shape —
 * and who is allowed to ask at all, which the engine deliberately does not decide.
 *
 * ALE-31 added six intent kinds for the game master's tools. Four of them — `spawn`, `set_flag`,
 * `advance_quest` and `set_disposition` — are world authoring: legal for the engine to perform and
 * nothing a person at a keyboard should be able to send. The engine validates that a `spawn` names
 * a real template; it has no concept of who asked. So the wire stops here, and those four reach the
 * engine only through `POST /gm/tool`. `cast` and `say` are player actions and are accepted.
 *
 * ALE-41 added `pass_time`, and it belongs on this side of the line for the same reason: it is the
 * player deciding to spend a moment. It is deliberately *not* a game master tool, so the world
 * cannot skip its own time — only a person can.
 */
const PLAYER_INTENTS = 'move, attack, cast, say, end_turn, pass_time';

export function isIntent(value: unknown): value is Intent {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'move':
      return isId(value['entity']) && isTile(value['to']);
    case 'attack':
      return isId(value['attacker']) && isId(value['target']) && isId(value['ability']);
    case 'end_turn':
    case 'pass_time':
      return isId(value['entity']);
    case 'cast':
      return isId(value['caster']) && isId(value['spell']) && isId(value['target']);
    case 'say': {
      const to = value['to'];
      const said = value['text'];
      return (
        isId(value['speaker']) &&
        typeof said === 'string' &&
        said.length > 0 &&
        said.length <= MAX_TEXT_LENGTH &&
        (to === null || isId(to))
      );
    }
    default:
      return false;
  }
}

/** `ws` hands us a string, a Buffer, or a list of Buffers depending on how the frame arrived. */
export function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data as Uint8Array[]).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return String(data);
}

/** Parses one frame off the wire into a `ClientMessage`, or explains why it was refused. */
export function parseClientFrame(text: string): FrameResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return bad('That frame was not valid JSON.');
  }
  if (!isRecord(value)) return bad('Every frame must be a JSON object.');
  const room = value['room'];
  if (!isId(room)) return bad('That frame is missing a room id.');

  switch (value['type']) {
    case 'join': {
      const protocol = value['protocol'];
      if (protocol !== PROTOCOL_VERSION) {
        return bad(
          `This server speaks protocol ${PROTOCOL_VERSION}; your client said ${JSON.stringify(protocol) ?? 'nothing'}. Reload the page.`,
        );
      }
      return { ok: true, message: { type: 'join', room, protocol: PROTOCOL_VERSION } };
    }
    case 'intent': {
      const turn = value['turn'];
      if (!Number.isInteger(turn) || (turn as number) < 0) {
        return bad('An intent must carry the turn number it was composed against.');
      }
      const intent = value['intent'];
      if (!isIntent(intent)) {
        return bad(`That is not an action this server understands (${PLAYER_INTENTS}).`);
      }
      return { ok: true, message: { type: 'intent', room, turn: turn as number, intent } };
    }
    // ALE-32. `preview_request` stages an action speculatively and `go` commits the last preview;
    // both carry the turn they were composed against, for the same reason an intent does.
    case 'preview_request': {
      const turn = value['turn'];
      if (!Number.isInteger(turn) || (turn as number) < 0) {
        return bad('A preview must carry the turn number it was composed against.');
      }
      const intent = value['intent'] ?? null;
      if (intent !== null && !isIntent(intent)) {
        return bad(`That is not an action this server understands (${PLAYER_INTENTS}).`);
      }
      const text = value['text'];
      if (text !== undefined && (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH)) {
        return bad(`Say something shorter than ${MAX_TEXT_LENGTH} characters.`);
      }
      return {
        ok: true,
        message: {
          type: 'preview_request',
          room,
          turn: turn as number,
          intent,
          ...(typeof text === 'string' ? { text } : {}),
        },
      };
    }
    case 'go': {
      const turn = value['turn'];
      if (!Number.isInteger(turn) || (turn as number) < 0) {
        return bad('A GO must carry the turn number it was composed against.');
      }
      return { ok: true, message: { type: 'go', room, turn: turn as number } };
    }
    // ALE-40. A hint that the player is hovering over this action; the server may warm its preview
    // cache with it, or may ignore it entirely. It carries a real intent because a speculation the
    // player never asked for has no free text to go with it and nothing to say about `null`.
    case 'speculate': {
      const turn = value['turn'];
      if (!Number.isInteger(turn) || (turn as number) < 0) {
        return bad('A speculation must carry the turn number it was composed against.');
      }
      const intent = value['intent'];
      if (!isIntent(intent)) {
        return bad(`That is not an action this server understands (${PLAYER_INTENTS}).`);
      }
      return { ok: true, message: { type: 'speculate', room, turn: turn as number, intent } };
    }
    default:
      return bad(`Unknown frame type ${JSON.stringify(value['type']) ?? 'undefined'}.`);
  }
}
