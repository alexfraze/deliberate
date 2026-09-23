import { describe, expect, it } from 'vitest';

import {
  THREAD_LIMIT,
  appendNarration,
  appendSpeech,
  extendsLine,
  initials,
  type SpeechInput,
  type ThreadEntry,
} from './dialogue.js';

const line = (speaker: string, text: string, over: Partial<SpeechInput> = {}): SpeechInput => ({
  speaker,
  name: speaker,
  faction: 'garrison',
  to: null,
  text,
  self: false,
  pending: false,
  ...over,
});

const texts = (entries: readonly ThreadEntry[]): string[] => entries.map((entry) => entry.text);

describe('appendSpeech', () => {
  it('keeps one entry per speaker turn, in order', () => {
    let thread: ThreadEntry[] = [];
    thread = appendSpeech(thread, line('halloran', 'Gate is sealed.'));
    thread = appendSpeech(thread, line('player', 'Open it.', { faction: 'party', self: true }));
    thread = appendSpeech(thread, line('halloran', 'No.'));
    expect(texts(thread)).toEqual(['Gate is sealed.', 'Open it.', 'No.']);
    expect(thread.map((entry) => entry.key)).toEqual([1, 2, 3]);
  });

  /**
   * The parley recording's signature defect. A preview and its GO are two model calls over the
   * same input, so the commit restates the preview's line and continues it; drawn as two entries
   * the character appears to stutter, which is exactly what "reads as a log" means.
   */
  it('merges a restated line into the one above it, keeping the finished thought', () => {
    let thread: ThreadEntry[] = [];
    thread = appendSpeech(thread, line('player', 'Ilva. Name your price.'));
    thread = appendSpeech(
      thread,
      line('player', 'Ilva. Name your price — I have twenty-five coin.'),
    );
    expect(texts(thread)).toEqual(['Ilva. Name your price — I have twenty-five coin.']);
    expect(thread[0]?.key).toBe(1);
  });

  it('merges when the restatement is the shorter of the two', () => {
    let thread = appendSpeech([], line('ilva', 'Twenty-five for linen. That is robbery.'));
    thread = appendSpeech(thread, line('ilva', 'Twenty-five for linen.'));
    expect(texts(thread)).toEqual(['Twenty-five for linen. That is robbery.']);
  });

  it('does not merge across speakers, or two different lines from one speaker', () => {
    let thread = appendSpeech([], line('halloran', 'Gate is sealed.'));
    thread = appendSpeech(thread, line('ilva', 'Gate is sealed. He means it.'));
    thread = appendSpeech(thread, line('ilva', 'Bring him a name.'));
    expect(texts(thread)).toEqual([
      'Gate is sealed.',
      'Gate is sealed. He means it.',
      'Bring him a name.',
    ]);
  });

  it('does not merge a restatement that something else was said in between', () => {
    let thread = appendSpeech([], line('player', 'Hail the gate!'));
    thread = appendSpeech(thread, line('halloran', 'Who is that?'));
    thread = appendSpeech(thread, line('player', 'Hail the gate! It is me.'));
    expect(texts(thread)).toEqual(['Hail the gate!', 'Who is that?', 'Hail the gate! It is me.']);
  });

  /** The local echo: what the player typed, superseded in place by the server's own line for them. */
  it('retires a pending player echo when the server confirms it', () => {
    let thread = appendSpeech([], line('player', 'Hail the gate!', { self: true, pending: true }));
    expect(thread[0]).toMatchObject({ pending: true });
    thread = appendSpeech(thread, line('player', 'Hail the gate!', { self: true }));
    expect(texts(thread)).toEqual(['Hail the gate!']);
    expect(thread[0]).toMatchObject({ pending: false, key: 1 });
  });

  it('bounds the thread', () => {
    let thread: ThreadEntry[] = [];
    for (let i = 0; i < THREAD_LIMIT + 25; i += 1) {
      thread = appendSpeech(thread, line(`npc-${i}`, `line ${i}`));
    }
    expect(thread).toHaveLength(THREAD_LIMIT);
    expect(thread[0]?.text).toBe('line 25');
    // Keys keep climbing, so a node drawn for a dropped entry can never be confused for a new one.
    expect(thread.at(-1)?.key).toBe(THREAD_LIMIT + 25);
  });
});

describe('extendsLine', () => {
  it('is true only for one utterance written out further', () => {
    expect(extendsLine('Stand where I can see you', 'Stand where I can see you, friend.')).toBe(
      true,
    );
    expect(extendsLine('Stand where I can see you.', 'Stand where I can')).toBe(true);
    expect(extendsLine('Stand where I can see you.', 'Bring him to the postern.')).toBe(false);
  });
});

describe('appendNarration', () => {
  it('folds streamed chunks into one block and seals it', () => {
    let thread = appendNarration([], 'The lamps gutter', false);
    thread = appendNarration(thread, ' in the wet air.', true);
    expect(texts(thread)).toEqual(['The lamps gutter in the wet air.']);
    expect(thread[0]).toMatchObject({ kind: 'narration', open: false });
  });

  it('starts a new block after the previous one is done', () => {
    let thread = appendNarration([], 'First.', true);
    thread = appendNarration(thread, 'Second.', true);
    expect(texts(thread)).toEqual(['First.', 'Second.']);
  });

  it('does not open a block for a stream that said nothing', () => {
    expect(appendNarration([], '', true)).toEqual([]);
  });

  it('keeps narration and speech as separate entries', () => {
    let thread: ThreadEntry[] = appendSpeech([], line('halloran', 'Gate is sealed.'));
    thread = appendNarration(thread, 'Rain runs off the slot.', true);
    thread = appendSpeech(thread, line('halloran', 'Gate is sealed.'));
    expect(thread.map((entry) => entry.kind)).toEqual(['speech', 'narration', 'speech']);
  });
});

describe('initials', () => {
  it('drops the role and takes the name', () => {
    expect(initials('Ilva Sallow, Pack Merchant')).toBe('IS');
    expect(initials('Halloran, Gate Warden')).toBe('HA');
    expect(initials('Brannoc, Wounded Scout')).toBe('BR');
    expect(initials('Player')).toBe('PL');
  });

  it('never comes back empty', () => {
    expect(initials('')).toBe('·');
    expect(initials('   ')).toBe('·');
  });
});
