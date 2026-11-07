// The command menu's fuzzy matcher (SPEC-005 §4.2), in-house: queries are short and the list is
// a few hundred commands, so a scoring subsequence match is fast enough (AC-9: < 16 ms for 300).

export type FuzzyMatch = {
  /** In (0, 1]: 1 for an exact match. */
  readonly score: number;
  /**
   * Indices of the matched characters in the text, for highlighting. They count code points
   * (`[...text]`), as the highlighter does, so emoji and astral characters don't shift them.
   */
  readonly indices: readonly number[];
};

const isWordStart = (chars: readonly string[], i: number) =>
  i === 0 || /[\s\-_./:(]/.test(chars[i - 1] ?? '');

/** The first index at or after `from` where `lower` holds `char` and `accept` agrees. */
function find(
  lower: readonly string[],
  char: string,
  from: number,
  accept: (i: number) => boolean = () => true,
): number {
  for (let i = from; i < lower.length; i++) if (lower[i] === char && accept(i)) return i;
  return -1;
}

/**
 * Matches the query's characters in order (case-insensitive, spaces ignored). Matches at word
 * starts and runs of consecutive characters score higher, so "gts" prefers "Go to settings" and
 * "set" prefers "Settings" over "Reset".
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const needle = [...query.toLocaleLowerCase().replace(/\s+/g, '')];
  if (needle.length === 0) return { score: 1, indices: [] };
  const chars = [...text];
  // Lower-cased per character, so indices stay aligned with `chars` ("İ" lower-cases to two).
  const lower = chars.map((char) => char.toLocaleLowerCase());
  if (lower.join('') === query.toLocaleLowerCase().trim()) {
    return { score: 1, indices: chars.map((_, i) => i) };
  }

  const indices: number[] = [];
  let points = 0;
  let from = 0;
  for (const char of needle) {
    const previous = indices.at(-1);
    const next = find(lower, char, from);
    // A consecutive character beats jumping to a later word start; otherwise prefer the next word
    // start that has this character, then any occurrence.
    let at =
      previous !== undefined && next === previous + 1
        ? next
        : find(lower, char, from, (i) => isWordStart(chars, i));
    if (at === -1) at = next;
    if (at === -1) return null;
    points += 1;
    if (isWordStart(chars, at)) points += 2;
    if (previous !== undefined && at === previous + 1) points += 1.5;
    if (at === 0) points += 1;
    indices.push(at);
    from = at + 1;
  }
  // Normalise: the best possible is every character a word start or consecutive, at position 0.
  const best = needle.length * 3 + 1;
  const spread = (indices.at(-1) ?? 0) - (indices[0] ?? 0) + 1;
  const compactness = needle.length / spread;
  const score = Math.min(0.99, (points / best) * 0.8 + compactness * 0.2);
  return { score, indices };
}

/** The best match over a title and its keywords; keyword matches count a little less. */
export function matchCommand(
  query: string,
  title: string,
  keywords: readonly string[] = [],
): { score: number; indices: readonly number[] } | null {
  const own = fuzzyMatch(query, title);
  let best = own;
  for (const keyword of keywords) {
    const match = fuzzyMatch(query, keyword);
    if (match !== null && (best === null || match.score * 0.8 > best.score)) {
      best = { score: match.score * 0.8, indices: [] };
    }
  }
  return best;
}
