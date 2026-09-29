import type { ClientMessage, ServerMessage } from '@deliberate/protocol';

/**
 * The allow-list, and the one place a new server frame has to be named before the client will look
 * at it. A frame type missing here is dropped silently, which is the right default for a hostile
 * socket and a trap for a new frame — so it is a literal tuple, and `messages.test.ts` asserts its
 * member type *equals* `ServerMessage['type']`. That makes an unlisted frame a red test rather than
 * a client that throws away something the server sent. ALE-52 found this the other way round.
 */
export const SERVER_MESSAGE_TYPES = [
  'snapshot',
  'preview',
  'diffs',
  'narration',
  'error',
  'abandoned',
] as const satisfies readonly ServerMessage['type'][];

const SERVER_TYPES: ReadonlySet<string> = new Set(SERVER_MESSAGE_TYPES);

/** Parses one websocket frame. Returns null for anything that is not a known server message. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || !SERVER_TYPES.has(type)) return null;
  return value as ServerMessage;
}

export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}
