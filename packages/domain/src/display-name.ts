/**
 * Display names: the @mention handle, unique case-insensitively (INV-02). The rule and the E5
 * suggestion are shared, so the invite page says what is wrong before the server does, in the
 * same words (SPEC-001 §3.4, E5, D9; PLAN-001 S5). `user.updateProfile` (S6) uses them too.
 */

export const DISPLAY_NAME_MAX_LENGTH = 32;

const DISPLAY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Why `displayName` can't be one, or undefined if it can. Surrounding spaces are ignored. */
export function displayNameProblem(displayName: string): string | undefined {
  const trimmed = displayName.trim();
  if (trimmed.length === 0) return 'Display name is required';
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    return `Display name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters long`;
  }
  if (!DISPLAY_NAME.test(trimmed)) {
    return 'Display name can use letters, digits, dots, dashes and underscores, like ada.l';
  }
  return undefined;
}

/**
 * A handle from someone's name or email, to start from (`Ada Lovelace` → `ada`): the first word,
 * lowercase, without accents or symbols; else the email's local part; else "member".
 */
export function displayNameFrom(name: string, email = ''): string {
  const handle = (source: string) =>
    source
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, DISPLAY_NAME_MAX_LENGTH);
  return handle(name.trim().split(/\s+/)[0] ?? '') || handle(email.split('@')[0] ?? '') || 'member';
}

/**
 * E5: the first of `wanted2`, `wanted3`, … that no one has (`taken` compares case-insensitively),
 * shortened so it stays a valid display name.
 */
export function suggestDisplayName(wanted: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  const base = wanted.trim();
  for (let n = 2; ; n += 1) {
    const suffix = String(n);
    const candidate = `${base.slice(0, DISPLAY_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The prefix every name `suggestDisplayName(wanted, …)` can return starts with, for looking up
 * the taken ones: at the length limit the suggestion shortens `wanted` to fit its number (up to
 * 4 digits here, which a workspace of any size never needs).
 */
export function displayNameSuggestionPrefix(wanted: string): string {
  return wanted.trim().slice(0, DISPLAY_NAME_MAX_LENGTH - 4);
}

/** E5's answer, with the suggestion. */
export function displayNameTakenMessage(suggestion: string): string {
  return `That display name is taken. Try ${suggestion}`;
}
