/** Git branch names for the "Copy git branch name" action (SPEC-012 §3.7, D19). */

/** Longest branch name, in characters, prefix and slug together (SPEC-012 D19). */
export const BRANCH_NAME_MAX = 60;

/** Letters NFKD leaves alone: they have no combining-mark decomposition (SPEC-012 §4.1). */
const TRANSLITERATIONS: Readonly<Record<string, string>> = {
  ß: 'ss',
  ẞ: 'ss',
  ø: 'o',
  Ø: 'o',
  æ: 'ae',
  Æ: 'ae',
  œ: 'oe',
  Œ: 'oe',
  đ: 'd',
  Đ: 'd',
  ł: 'l',
  Ł: 'l',
  þ: 'th',
  Þ: 'th',
};

/**
 * The one folding function for slugs (SPEC-012 §4.1, D19): transliterates `ß ø æ œ đ ł þ`,
 * strips diacritics (NFKD), lowercases, and turns every run of other characters into one
 * hyphen, trimmed. PLAN-011 S4's `issueSlug` must use this function, not a copy, so the issue
 * URL slug and the branch name never disagree.
 */
export function foldToSlug(text: string): string {
  return text
    .replace(/[ßẞøØæÆœŒđĐłŁþÞ]/gu, (c) => TRANSLITERATIONS[c] ?? c)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * `<displayName>/<identifier lowercased>-<title slug>`, at most 60 characters in total. `slug` is
 * `issueSlug(title)`: it is a parameter until PLAN-011 S4 lands that function. A name with no
 * letters or digits is left out, and so is an empty slug. The slug is cut on a word boundary when
 * it has one; the prefix is never cut unless it alone is too long.
 */
export function gitBranchName(displayName: string, identifier: string, slug: string): string {
  const name = foldToSlug(displayName);
  const id = foldToSlug(identifier);
  const prefix = name === '' ? id : `${name}/${id}`;
  if (prefix.length >= BRANCH_NAME_MAX) {
    return prefix.slice(0, BRANCH_NAME_MAX).replace(/[-/]+$/, '');
  }
  const cleanSlug = foldToSlug(slug);
  const room = BRANCH_NAME_MAX - prefix.length - 1;
  if (cleanSlug === '' || room <= 0) return prefix;
  let cut = cleanSlug;
  if (cut.length > room) {
    cut = cut.slice(0, room);
    // A cut inside a word goes back to the last hyphen, unless that would empty the slug.
    if (cleanSlug[room] !== '-') {
      const hyphen = cut.lastIndexOf('-');
      if (hyphen > 0) cut = cut.slice(0, hyphen);
    }
    cut = cut.replace(/-+$/, '');
  }
  return cut === '' ? prefix : `${prefix}-${cut}`;
}
