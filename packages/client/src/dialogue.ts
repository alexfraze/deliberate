/**
 * The conversation thread, as pure data (ALE-35).
 *
 * Conversation is the bulk of what the game master does — the recorded `parley` session is 34
 * `DialogueLine` diffs in ten player turns, `m1-acceptance` 33 — and until now every one of them
 * landed in the same undifferentiated narration box, so an exchange read as a wall of log. What a
 * thread needs in order to read as dialogue is three distinctions the raw diff stream does not
 * make on its own: who is speaking, whether a block is speech or scene prose, and which side of
 * the conversation it belongs to. That is all this file is.
 *
 * No DOM and no palette, so the two awkward parts — merging a restated line and folding streamed
 * narration chunks — are unit-testable under node. `thread.ts` draws what this returns.
 *
 * Every string in here is model output. Nothing formats it into markup; `thread.ts` puts it on
 * screen through `textContent`.
 */
import type { EntityId } from '@deliberate/protocol';

export interface SpeechEntry {
  kind: 'speech';
  /** Stable across a merge, so the renderer can update one line instead of rebuilding the thread. */
  key: number;
  speaker: EntityId;
  name: string;
  faction: string;
  /** Who it was said to, already named. Null when it was said to the room. */
  to: string | null;
  text: string;
  /** The player's side of the conversation, which is drawn facing the other way. */
  self: boolean;
  /** Said here and not yet confirmed by the server — the player's own text, mid-flight. */
  pending: boolean;
}

export interface NarrationEntry {
  kind: 'narration';
  key: number;
  text: string;
  /** Still streaming: the next chunk extends this entry rather than starting another one. */
  open: boolean;
}

export type ThreadEntry = SpeechEntry | NarrationEntry;

/** What a caller supplies for one spoken line; `key` is the thread's to assign. */
export type SpeechInput = Omit<SpeechEntry, 'kind' | 'key'>;

/**
 * How many entries the thread keeps. A session runs for hours and every line is a DOM node, so
 * scrollback is deep but not unbounded — older lines leave existence, not merely the viewport.
 */
export const THREAD_LIMIT = 200;

function nextKey(entries: readonly ThreadEntry[]): number {
  return (entries[entries.length - 1]?.key ?? 0) + 1;
}

function capped(entries: ThreadEntry[]): ThreadEntry[] {
  return entries.length <= THREAD_LIMIT ? entries : entries.slice(entries.length - THREAD_LIMIT);
}

/**
 * Whether two texts are the same utterance, one of them written out further.
 *
 * This is not a guess about language, it is a fact about the preview loop: a preview and its GO
 * are two separate model calls over the same input, so the commit reproduces the line the preview
 * already showed and then continues it. `parley` has four of these — "Ilva. There is bandage linen
 * in that pack. Name your price." followed by the same sentence plus "— I have twenty-five coin"
 * — and rendering both is the single most log-like thing the old box did: the player reads the
 * same sentence twice and concludes the character is stuttering.
 */
export function extendsLine(previous: string, next: string): boolean {
  const [short, long] = previous.length <= next.length ? [previous, next] : [next, previous];
  if (short === long) return true;
  // The shorter one was a finished sentence, so it ends in punctuation the longer one replaced
  // with a comma or a dash on the way to saying more. Compare the words, not the full stop.
  const stem = short.replace(TRAILING_PUNCTUATION, '');
  if (stem.length < MIN_STEM || !long.startsWith(stem)) return false;
  // And the extension has to begin a new word, so "No." never swallows "Nobody moves."
  return !/[\p{L}\p{N}]/u.test(long.charAt(stem.length));
}

const TRAILING_PUNCTUATION = /[\s.,;:!?…—–-]+$/u;

/**
 * How much of a line has to match before a restatement is believed. Short enough that any real
 * restatement clears it, long enough that two characters both starting "Aye" are still two lines.
 */
const MIN_STEM = 12;

/**
 * Adds one spoken line, merging it into the line above when that is the same speaker restating the
 * same utterance. The longer text wins, because the longer one is the finished thought.
 *
 * The same rule retires the player's optimistic local echo: what they typed is appended `pending`
 * the moment they press Say, and the server's own `DialogueLine` for them arrives as a superset of
 * it thirty seconds later and takes its place rather than appearing underneath it.
 */
export function appendSpeech(entries: readonly ThreadEntry[], line: SpeechInput): ThreadEntry[] {
  const last = entries[entries.length - 1];
  if (
    last?.kind === 'speech' &&
    last.speaker === line.speaker &&
    extendsLine(last.text, line.text)
  ) {
    const merged: SpeechEntry = {
      ...line,
      kind: 'speech',
      key: last.key,
      text: line.text.length >= last.text.length ? line.text : last.text,
    };
    return [...entries.slice(0, -1), merged];
  }
  return capped([...entries, { ...line, kind: 'speech', key: nextKey(entries) }]);
}

/**
 * Folds one narration chunk in. Narration arrives streamed, so a chunk extends the open block; the
 * `done` frame seals it, and the next chunk after that starts a new block of scene prose.
 */
export function appendNarration(
  entries: readonly ThreadEntry[],
  chunk: string,
  done: boolean,
): ThreadEntry[] {
  const last = entries[entries.length - 1];
  if (last?.kind === 'narration' && last.open) {
    const merged: NarrationEntry = { ...last, text: last.text + chunk, open: !done };
    return [...entries.slice(0, -1), merged];
  }
  // A `done` with nothing before it, or an empty chunk, is a stream that said nothing. No block.
  if (!chunk) return [...entries];
  return capped([
    ...entries,
    { kind: 'narration', key: nextKey(entries), text: chunk, open: !done },
  ]);
}

/**
 * The letters a placeholder portrait carries until there is art.
 *
 * Names here are "Ilva Sallow, Pack Merchant" — a name and then a role — so the role is dropped
 * and the initials come from the name: `IS`, `BR`, `HA`. Two letters rather than one because
 * `garrison` fields two characters and one letter would put `H` and `B` in the same coloured box.
 */
export function initials(name: string): string {
  const words = (name.split(',')[0] ?? name)
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean);
  const first = words[0] ?? '';
  const second = words[1] ?? '';
  const pair = second ? `${first[0] ?? ''}${second[0] ?? ''}` : first.slice(0, 2);
  return pair.toUpperCase() || '·';
}
