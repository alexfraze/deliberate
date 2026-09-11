import { PROTOCOL_VERSION, type ClientMessage, type Intent, type Tile } from '@deliberate/protocol';

/**
 * Wire validation for ALE-11. Nothing that arrives on a socket is trusted: a frame becomes a
 * `ClientMessage` only after every field it carries has been checked here, so the room and the
 * engine only ever see well-formed shapes. Failures come back as a reason a player could read.
 */

export type FrameResult = { ok: true; message: ClientMessage } | { ok: false; reason: string };

/** Longest id or ability key accepted off the wire; keeps a hostile client from sending novels. */
const MAX_ID_LENGTH = 128;

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

/** Type guard for the M0 intents. Legality is the engine's job; this only checks the shape. */
export function isIntent(value: unknown): value is Intent {
  if (!isRecord(value)) return false;
  switch (value['kind']) {
    case 'move':
      return isId(value['entity']) && isTile(value['to']);
    case 'attack':
      return isId(value['attacker']) && isId(value['target']) && isId(value['ability']);
    case 'end_turn':
      return isId(value['entity']);
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
        return bad('That is not an action this server understands (move, attack, end_turn).');
      }
      return { ok: true, message: { type: 'intent', room, turn: turn as number, intent } };
    }
    default:
      return bad(`Unknown frame type ${JSON.stringify(value['type']) ?? 'undefined'}.`);
  }
}
