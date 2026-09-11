import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  DEFAULT_ROOM,
  DIFF_TYPES,
  HASH_EXCLUDED_COMPONENTS,
  PROTOCOL_VERSION,
  TILE_FEET,
  type ClientMessage,
  type Diff,
  type ServerMessage,
  type Verdict,
} from './index.js';

describe('protocol constants', () => {
  it('pins the blueprint numbers', () => {
    expect(TILE_FEET).toBe(5);
    expect(PROTOCOL_VERSION).toBe(1);
    expect(DEFAULT_ROOM).toBe('main');
  });

  it('lists every diff type exactly once', () => {
    expect(new Set(DIFF_TYPES).size).toBe(DIFF_TYPES.length);
    expectTypeOf<Diff['type']>().toEqualTypeOf<(typeof DIFF_TYPES)[number]>();
  });

  it('excludes only cosmetic components from the hash', () => {
    expect(HASH_EXCLUDED_COMPONENTS).toEqual(['dialogue', 'portrait']);
  });
});

describe('protocol shapes', () => {
  it('discriminates client and server messages on `type`', () => {
    expectTypeOf<ClientMessage['type']>().toEqualTypeOf<
      'join' | 'intent' | 'preview_request' | 'go'
    >();
    expectTypeOf<ServerMessage['type']>().toEqualTypeOf<
      'snapshot' | 'preview' | 'diffs' | 'narration' | 'error'
    >();
  });

  it('never lets a rejected verdict carry diffs', () => {
    const rejected: Verdict = { ok: false, reason: 'out of range', diff: [] };
    expect(rejected.diff).toHaveLength(0);
    expectTypeOf<Extract<Verdict, { ok: false }>['diff']>().toEqualTypeOf<[]>();
  });
});
