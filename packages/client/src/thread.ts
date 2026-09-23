/**
 * The dialogue region (ALE-35): the conversation, drawn where a conversation belongs.
 *
 * **Why this is not part of the panel.** The right-hand column is the *controls*: the speech box,
 * what is staged, the busy clock, the preview, the telegraphed reactions, GO, End turn and Wait.
 * It is already tight enough that one long preview once pushed GO off the bottom of the screen.
 * A transcript is the opposite kind of thing — it is content, it only grows, and it is read rather
 * than operated — so putting it in that column means capping it, and capping a transcript is how
 * you get a transcript nobody can read. It gets its own region on the empty left edge instead,
 * and reports its width so the board recentres in what is left, exactly as the panel does on the
 * right. The two sides of the conversation then sit on the two sides of the screen: what was said
 * on the left, what you are about to say on the right.
 *
 * **Portrait slots.** `.dl-portrait` is a fixed 34px box carrying the speaker's initials over
 * their faction colour from `palette.ts`. It is sized and positioned as though the art already
 * existed, so the other half of this issue — image-generated, palette-locked portraits — drops in
 * by returning a URL from `portraitUrl` and changes no layout at all.
 *
 * Every line here is model output and goes in through `textContent`. The only thing derived from
 * it that reaches CSS is a faction colour, and that comes from the palette, not from the string.
 */
import type { DialogueLine, EntityId } from '@deliberate/protocol';

import {
  appendNarration,
  appendSpeech,
  initials,
  type SpeechInput,
  type ThreadEntry,
} from './dialogue.js';
import { factionColor, type Palette } from './palette.js';

/** What the client knows about whoever is speaking. The view knows it; the thread does not keep a copy. */
export interface Speaker {
  name: string;
  faction: string;
}

/**
 * Which side of the conversation a faction is on. `party` is the player's side, which is also the
 * palette's name for it — so "your own line" needs no extra state, no player id and no guess.
 */
export const SELF_FACTION = 'party';

export interface DialogueThreadOptions {
  speakerOf(id: EntityId): Speaker;
  /** The player's entity, so their local echo merges with the server's line for them. */
  selfId(): EntityId | null;
  /** The region appeared, collapsed or emptied: the board's usable width changed. */
  onLayout(): void;
  /**
   * Where a real portrait lives, once there is art. The default — no portraits — leaves the
   * initials in the slot; returning a URL fills the same box and nothing else moves.
   */
  portraitUrl?(id: EntityId): string | null;
}

export interface DialogueThread {
  /** A **committed** `DialogueLine` diff. Preview diffs have not happened and never come here. */
  say(line: DialogueLine): void;
  /** What the player just typed, echoed locally while the game master thinks about it. */
  playerSaid(text: string): void;
  narrate(chunk: string, done: boolean): void;
  /** A new snapshot is a new world; the conversation that came before it is not this one's. */
  clear(): void;
  setPalette(palette: Palette): void;
  /** CSS pixels of the left edge the thread covers. 0 when it is hidden or collapsed. */
  width(): number;
}

/** How close to the bottom still counts as "following along", in pixels. */
const STICK_SLOP = 32;

export function createDialogueThread(
  root: HTMLElement,
  options: DialogueThreadOptions,
): DialogueThread {
  root.replaceChildren();
  root.hidden = true;

  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'dl-thread-title';

  const list = document.createElement('div');
  list.className = 'dl-thread-list';

  // Scrollback only works if reading back does not get yanked to the bottom by the next line. The
  // thread follows the conversation while you are at the bottom and holds still once you are not,
  // and this is how you get back.
  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'dl-thread-jump';
  jump.textContent = 'latest ↓';
  jump.hidden = true;

  root.append(title, list, jump);

  let entries: ThreadEntry[] = [];
  let palette: Palette | null = null;
  let collapsed = false;
  /**
   * Whether the reader is following the conversation. Deliberately a remembered intent rather than
   * a measurement taken while painting: growing the content moves the bottom away without firing a
   * scroll event, so a thread that measured itself mid-append would decide the reader had scrolled
   * back when all that happened was that somebody said something.
   */
  let following = true;
  /** The node drawn for each entry key, and the text it currently shows. */
  const drawn = new Map<number, { node: HTMLElement; body: HTMLElement; text: string }>();

  const atBottom = (): boolean =>
    list.scrollHeight - list.scrollTop - list.clientHeight <= STICK_SLOP;

  const toBottom = (): void => {
    following = true;
    list.scrollTop = list.scrollHeight;
    jump.hidden = true;
  };

  const colorOf = (faction: string): string =>
    palette ? factionColor(palette, faction) : 'currentColor';

  const paintTitle = (): void => {
    const lines = entries.length;
    title.textContent = `${collapsed ? '▸' : '▾'} conversation · ${lines} ${lines === 1 ? 'line' : 'lines'}`;
  };

  function buildSpeech(entry: Extract<ThreadEntry, { kind: 'speech' }>): {
    node: HTMLElement;
    body: HTMLElement;
  } {
    const node = document.createElement('div');
    node.className = 'dl-line';
    node.classList.toggle('is-self', entry.self);
    node.dataset['faction'] = entry.faction;

    // The portrait slot. Fixed size and its own element from the start, so real art is one
    // background-image away from dropping in without a relayout.
    const portrait = document.createElement('div');
    portrait.className = 'dl-portrait';
    portrait.dataset['entity'] = entry.speaker;
    const url = options.portraitUrl?.(entry.speaker) ?? null;
    if (url) portrait.style.backgroundImage = `url(${CSS.escape(url)})`;
    else portrait.textContent = initials(entry.name);

    const who = document.createElement('div');
    who.className = 'dl-who';
    who.textContent = entry.name;
    if (entry.to !== null) {
      const to = document.createElement('span');
      to.className = 'dl-to';
      to.textContent = `→ ${entry.to}`;
      who.append(to);
    }

    const said = document.createElement('p');
    said.className = 'dl-said';

    const column = document.createElement('div');
    column.className = 'dl-body';
    column.append(who, said);
    node.append(portrait, column);
    return { node, body: said };
  }

  function build(entry: ThreadEntry): { node: HTMLElement; body: HTMLElement } {
    if (entry.kind === 'narration') {
      // Scene prose, not somebody talking: no portrait, no name, no side. It reads as a stage
      // direction because it is drawn as one.
      const node = document.createElement('p');
      node.className = 'dl-scene';
      return { node, body: node };
    }
    return buildSpeech(entry);
  }

  const paint = (): void => {
    const live = new Set(entries.map((entry) => entry.key));
    for (const [key, held] of drawn) {
      if (live.has(key)) continue;
      held.node.remove();
      drawn.delete(key);
    }
    for (const entry of entries) {
      let held = drawn.get(entry.key);
      if (!held) {
        const built = build(entry);
        held = { ...built, text: '' };
        drawn.set(entry.key, held);
        // Entries only ever arrive at the end and only ever leave from the front, so appending in
        // iteration order keeps the DOM in the thread's order without any index arithmetic.
        list.append(built.node);
      }
      if (entry.kind === 'speech') {
        held.node.style.setProperty('--dl-speaker', colorOf(entry.faction));
        held.node.classList.toggle('is-pending', entry.pending);
      }
      if (held.text !== entry.text) {
        held.body.textContent = entry.text;
        held.text = entry.text;
      }
    }
    const empty = entries.length === 0;
    if (root.hidden !== empty) {
      root.hidden = empty;
      options.onLayout();
    }
    paintTitle();
    if (following) toBottom();
    else jump.hidden = false;
  };

  const push = (next: ThreadEntry[]): void => {
    entries = next;
    paint();
  };

  // The only thing that stops the thread following is the reader scrolling away from the bottom,
  // and the only things that resume it are scrolling back or the button.
  list.addEventListener('scroll', () => {
    following = atBottom();
    if (following) jump.hidden = true;
  });
  jump.addEventListener('click', toBottom);
  title.addEventListener('click', () => {
    collapsed = !collapsed;
    root.classList.toggle('is-collapsed', collapsed);
    paintTitle();
    options.onLayout();
    if (!collapsed) toBottom();
  });

  /** A line as the thread wants it: names resolved, side decided, addressee named. */
  const toSpeech = (
    speaker: EntityId,
    text: string,
    to: EntityId | null,
    pending: boolean,
  ): SpeechInput => {
    const who = options.speakerOf(speaker);
    const self = who.faction === SELF_FACTION;
    const target = to === null ? null : options.speakerOf(to);
    return {
      speaker,
      name: who.name,
      faction: who.faction,
      // Named only when the line went to somebody who is not you. Almost everything said in a
      // parley is said to you, so "→ you" on every second entry is noise that hides the one fact
      // worth having: the moment a character turns and shouts at somebody else.
      to: target === null || target.faction === SELF_FACTION ? null : target.name,
      text,
      self,
      pending,
    };
  };

  return {
    say(line) {
      push(appendSpeech(entries, toSpeech(line.speaker, line.text, line.to, false)));
    },
    playerSaid(text) {
      const id = options.selfId();
      // With no party entity to attribute it to the echo still belongs in the thread — the player
      // did say it — it simply cannot be superseded by the server's line for them later.
      if (id === null) {
        push(
          appendSpeech(entries, {
            speaker: 'you',
            name: 'You',
            faction: SELF_FACTION,
            to: null,
            text,
            self: true,
            pending: true,
          }),
        );
        return;
      }
      push(appendSpeech(entries, toSpeech(id, text, null, true)));
    },
    narrate(chunk, done) {
      push(appendNarration(entries, chunk, done));
    },
    clear() {
      for (const held of drawn.values()) held.node.remove();
      drawn.clear();
      push([]);
    },
    setPalette(next) {
      palette = next;
      for (const entry of entries) {
        if (entry.kind !== 'speech') continue;
        drawn.get(entry.key)?.node.style.setProperty('--dl-speaker', colorOf(entry.faction));
      }
    },
    width() {
      if (root.hidden || collapsed) return 0;
      return root.getBoundingClientRect().width;
    },
  };
}
