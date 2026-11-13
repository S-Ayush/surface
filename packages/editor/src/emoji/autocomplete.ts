/**
 * `:name` autocomplete (SPEC-013 §3.5): `:` plus two letters lists emoji by shortcode from the
 * bundled data; `Enter` or `Tab` inserts the emoji as plain text (no node). `:name:` typed in
 * full also converts, once the data is loaded.
 */
import { InputRule, type Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import type { SuggestionMatch } from '../suggestion.js';
import { loadedEmoji, type Emoji } from './data.js';

/** `:` after a space or at the line start, then at least two shortcode characters. */
const TRIGGER = /(?:^|\s):([a-z0-9_+-]{2,})$/i;
const COMPLETE = /(?:^|\s):([a-z0-9_+-]+):$/i;
const MAX_ITEMS = 8;

/** The `:ab` before the cursor, outside code, as a suggestion match. */
export function matchEmojiTrigger(state: EditorState): SuggestionMatch | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code === true) return null;
  if ($from.marks().some((mark) => mark.type.spec.code === true)) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const found = TRIGGER.exec(before);
  const query = found?.[1];
  if (query === undefined) return null;
  const length = query.length + 1; // the colon
  return { from: $from.pos - length, to: $from.pos, query: query.toLowerCase() };
}

/** Shortcode prefix matches first, then shortcodes that contain the query, then tags. */
export function searchEmoji(
  emoji: readonly Emoji[],
  query: string,
  limit = MAX_ITEMS,
): readonly Emoji[] {
  const needle = query.toLowerCase();
  const prefix: Emoji[] = [];
  const contains: Emoji[] = [];
  const tagged: Emoji[] = [];
  for (const entry of emoji) {
    if (entry.shortcodes.some((code) => code.startsWith(needle))) prefix.push(entry);
    else if (entry.shortcodes.some((code) => code.includes(needle))) contains.push(entry);
    else if (entry.tags.some((tag) => tag.toLowerCase().startsWith(needle))) tagged.push(entry);
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...contains, ...tagged].slice(0, limit);
}

/** `:thumbs_up:` typed in full becomes the emoji, if the shortcode is known. */
export function emojiShortcodeRule(): InputRule {
  return new InputRule({
    find: COMPLETE,
    handler: ({ state, range, match }) => {
      const name = match[1]?.toLowerCase();
      const data = loadedEmoji();
      if (name === undefined || data === null) return null;
      const found = data.find((entry) => entry.shortcodes.includes(name));
      if (found === undefined) return null;
      // The match may start with the space before the colon: keep it.
      const text = match[0];
      const start = range.from + (text.startsWith(':') ? 0 : 1);
      state.tr.replaceWith(start, range.to, state.schema.text(found.unicode));
      return undefined;
    },
  });
}

/** Replaces `:query` with the emoji, as plain text (§3.5: there is no emoji node). */
export function applyEmoji(editor: Editor, match: SuggestionMatch, item: Emoji): void {
  editor.chain().focus().insertContentAt({ from: match.from, to: match.to }, item.unicode).run();
}
