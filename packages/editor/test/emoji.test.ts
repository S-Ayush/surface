// PLAN-013 S2: the bundled emoji data is valid for the server's check (SPEC-013 §4.4 "Emoji", AC-15)
// and `isSingleEmoji` is the one definition both sides use.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { searchEmoji } from '../src/emoji/autocomplete.js';
import { loadEmoji, loadedEmoji } from '../src/emoji/data.js';
import { isSingleEmoji } from '../src/schema/index.js';

interface Raw {
  readonly hexcode: string;
  readonly unicode: string;
  readonly skins?: readonly { readonly unicode: string }[];
}

// The pinned package's own file, not our loader's output, so the filter in the loader is checked.
const raw = createRequire(import.meta.url)('emojibase-data/en/compact.json') as readonly Raw[];

const isRegionalIndicator = (entry: Raw) => /^1F1(?:E[6-9A-F]|F[0-9A-F])$/.test(entry.hexcode);

/**
 * Emoji of emojibase-data 18.0.0 that Node 24's ICU (Unicode 17.0) doesn't know yet, so the
 * server's `\p{RGI_Emoji}` check refuses them (SPEC-013 §4.4 names this skew). The loader drops
 * them, so the picker never offers what `reaction.set` would refuse. Shrinks when Node moves on.
 */
const NEWER_THAN_NODE = new Set([
  '1FAEB',
  '1FAF9',
  '1FAFA',
  '1FACC',
  '1FADD',
  '1F6D9',
  '1FA8B',
  '1FA8C',
  '1FA8D',
]);

describe('isSingleEmoji', () => {
  it.each(['👍', '👍🏽', '👨‍👩‍👧', '🇳🇱', '1️⃣', '❤️', '🏴󠁧󠁢󠁷󠁬󠁳󠁿'])('accepts %s', (value) => {
    expect(isSingleEmoji(value)).toBe(true);
  });

  it.each(['', 'a', ':+1:', '👍👍', 'x👍', '👍 ', '🇦', '👍\u0000', 'ab'.repeat(40)])(
    'refuses %j',
    (value) => {
      expect(isSingleEmoji(value)).toBe(false);
    },
  );
});

describe('the pinned emoji data (AC-15)', () => {
  it('has every emoji of the package, except letters alone and emoji newer than Node', async () => {
    const emoji = await loadEmoji();
    const offered = new Set(emoji.map((entry) => entry.unicode));
    const dropped = raw.filter((entry) => !offered.has(entry.unicode));
    expect(dropped.length).toBeGreaterThan(0);
    expect(
      dropped.every((entry) => isRegionalIndicator(entry) || NEWER_THAN_NODE.has(entry.hexcode)),
    ).toBe(true);
    expect(emoji.length).toBeGreaterThan(1800);
  });

  it('only offers emoji (and skin tone variants) that pass isSingleEmoji', async () => {
    const emoji = await loadEmoji();
    const refused = emoji.flatMap((entry) =>
      [entry.unicode, ...entry.skins].filter((value) => !isSingleEmoji(value)),
    );
    expect(refused).toEqual([]);
  });

  it('keeps every skin tone variant the package has for what it offers', async () => {
    const emoji = await loadEmoji();
    const byEmoji = new Map(emoji.map((entry) => [entry.unicode, entry]));
    for (const entry of raw) {
      const offered = byEmoji.get(entry.unicode);
      if (offered === undefined) continue;
      expect(offered.skins).toEqual((entry.skins ?? []).map((skin) => skin.unicode));
    }
  });

  it('has the same list once loaded, and loads it only once', async () => {
    const first = await loadEmoji();
    expect(await loadEmoji()).toBe(first);
    expect(loadedEmoji()).toBe(first);
  });
});

describe('searchEmoji', () => {
  it('finds an emoji by shortcode prefix, best match first', async () => {
    const emoji = await loadEmoji();
    expect(searchEmoji(emoji, 'thumbsu')[0]?.unicode).toBe('👍');
    expect(searchEmoji(emoji, 'grinn')[0]?.shortcodes[0]).toBe('grinning');
  });

  it('is case-insensitive, limited and empty for nonsense', async () => {
    const emoji = await loadEmoji();
    expect(searchEmoji(emoji, 'THUMBSUP')[0]?.unicode).toBe('👍');
    expect(searchEmoji(emoji, 'a', 5)).toHaveLength(5);
    expect(searchEmoji(emoji, 'zzzzqqqq')).toEqual([]);
  });
});
