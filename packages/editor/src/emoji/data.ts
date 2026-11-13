/**
 * The bundled emoji data (SPEC-013 §4.4 "Emoji", D22): the pinned `emojibase-data` English compact
 * set and its shortcodes, loaded lazily so the editor's entry chunk stays small. No network: the
 * JSON is part of the build (rule 5). The `emojibase` package itself (it can fetch from a CDN) is
 * banned by ESLint.
 */
import { isSingleEmoji } from '../schema/emoji.js';

export interface Emoji {
  readonly unicode: string;
  readonly label: string;
  /** Shortcodes without colons, the primary one first. Some emoji have none. */
  readonly shortcodes: readonly string[];
  readonly tags: readonly string[];
  /** emojibase group: 0 smileys … 9 flags (2 is the component group, never offered). */
  readonly group: number;
  readonly order: number;
  /** Skin tone variants, in emojibase order. */
  readonly skins: readonly string[];
}

interface RawEmoji {
  readonly hexcode: string;
  readonly label: string;
  readonly unicode: string;
  readonly group?: number;
  readonly order?: number;
  readonly tags?: readonly string[];
  readonly skins?: readonly { readonly unicode: string }[];
}

type RawShortcodes = Readonly<Record<string, string | readonly string[]>>;

let loading: Promise<readonly Emoji[]> | null = null;
let loaded: readonly Emoji[] | null = null;

async function load(): Promise<readonly Emoji[]> {
  // Dynamic imports: bundlers split these into their own chunk.
  const [compact, shortcodes] = await Promise.all([
    import('emojibase-data/en/compact.json'),
    import('emojibase-data/en/shortcodes/emojibase.json'),
  ]);
  const raw: readonly RawEmoji[] = compact.default;
  const codes: RawShortcodes = shortcodes.default;
  const result: Emoji[] = [];
  for (const entry of raw) {
    // Regional indicator letters are not RGI emoji on their own: the server would refuse them
    // as a reaction, so the picker and the autocomplete never offer them.
    if (!isSingleEmoji(entry.unicode)) continue;
    const code = codes[entry.hexcode];
    result.push({
      unicode: entry.unicode,
      label: entry.label,
      shortcodes: code === undefined ? [] : typeof code === 'string' ? [code] : [...code],
      tags: entry.tags ?? [],
      group: entry.group ?? 0,
      order: entry.order ?? 0,
      skins: (entry.skins ?? []).map((skin) => skin.unicode).filter(isSingleEmoji),
    });
  }
  return result;
}

/** All emoji, loaded once. A failed load is retried on the next call. */
export function loadEmoji(): Promise<readonly Emoji[]> {
  loading ??= load().then(
    (emoji) => {
      loaded = emoji;
      return emoji;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** The emoji, once `loadEmoji()` has resolved; null before. */
export function loadedEmoji(): readonly Emoji[] | null {
  return loaded;
}
