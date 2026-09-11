import { createHash } from 'node:crypto';

import { HASH_EXCLUDED_COMPONENTS, type Snapshot, type StateHash } from '@deliberate/protocol';

/**
 * Canonical JSON: object keys sorted, `undefined` members dropped, arrays in order, numbers in
 * JS shortest round-trip form (with -0 normalised to 0). Two structurally equal values always
 * produce the same text regardless of insertion order or how they were (de)serialised.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`cannot canonicalize ${value}`);
      return JSON.stringify(value === 0 ? 0 : value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      break;
    default:
      throw new TypeError(`cannot canonicalize a ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

/**
 * The part of a snapshot that the state hash covers: everything except the components listed in
 * `HASH_EXCLUDED_COMPONENTS` (cosmetic: dialogue seeds, portraits). Returns a new object; the
 * input is not modified.
 */
export function hashableSnapshot(snapshot: Snapshot): Snapshot {
  const entities: Snapshot['entities'] = {};
  for (const [id, entity] of Object.entries(snapshot.entities)) {
    const components = { ...entity.components };
    for (const name of HASH_EXCLUDED_COMPONENTS) delete components[name];
    entities[id] = { ...entity, components };
  }
  return { ...snapshot, entities };
}

export function blake2b(text: string): string {
  return createHash('blake2b512').update(text, 'utf8').digest('hex');
}

/**
 * Canonical Blake2b-512 hex digest of the snapshot with cosmetic components excluded. Same
 * state, same hash, whatever the key order and whether or not it went through JSON on the way.
 */
export function hashSnapshot(snapshot: Snapshot): StateHash {
  return blake2b(canonicalize(hashableSnapshot(snapshot)));
}
