import type { ClientMessage, ServerMessage } from '@deliberate/protocol';

const SERVER_TYPES = new Set<ServerMessage['type']>([
  'snapshot',
  'preview',
  'diffs',
  'narration',
  'error',
]);

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
  if (typeof type !== 'string' || !SERVER_TYPES.has(type as ServerMessage['type'])) return null;
  return value as ServerMessage;
}

export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}
