/**
 * Team key suggestions (SPEC-001 §4, AC-11, E11). Shared so the client suggests a key while the
 * user types, and the server suggests the same one for `team.suggestKey` and `team.create`.
 *
 * The initials of the name's words (up to 3), or the first 3 letters of a one-word name,
 * uppercased: `Engineering` → `ENG`, `Mobile Platform` → `MP`. When that key is taken or
 * reserved, it grows a letter at a time from the name (`ENGI`, `ENGIN`; `MPL`, `MPLA`), then
 * falls back to the name's first letters. If nothing fits, there is no suggestion and the user
 * picks a key.
 */
import { TEAM_KEY_PATTERN, teamKeyProblem } from './workspace.js';

const MAX_INITIALS = 3;
const MAX_KEY_LENGTH = 5;

/** The name's words as A–Z letters, uppercased; accents dropped (`Équipe` → `EQUIPE`). */
function words(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^A-Za-z]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toUpperCase());
}

/** Every key the name suggests, best first, before checking which are free. */
export function teamKeyCandidates(name: string): string[] {
  const parts = words(name);
  const candidates: string[] = [];
  const add = (key: string) => {
    if (TEAM_KEY_PATTERN.test(key) && !candidates.includes(key)) candidates.push(key);
  };
  const [first] = parts;
  if (first === undefined) return [];

  if (parts.length === 1) {
    for (let length = 3; length <= MAX_KEY_LENGTH; length++) add(first.slice(0, length));
    // A two-letter name is its own key.
    add(first);
    return candidates;
  }

  const used = parts.slice(0, MAX_INITIALS);
  const initials = used.map((word) => word.charAt(0)).join('');
  add(initials);
  // Grow from the last word used: Mobile Platform → MPL, MPLA, MPLAT.
  const last = used.at(-1) ?? '';
  for (let extra = 1; initials.length + extra <= MAX_KEY_LENGTH; extra++) {
    if (extra >= last.length) break;
    add(initials + last.slice(1, 1 + extra));
  }
  // Then the name's first letters, as for one word: Mobile Platform → MOB, MOBI, MOBIL.
  const letters = parts.join('');
  for (let length = 3; length <= MAX_KEY_LENGTH; length++) add(letters.slice(0, length));
  return candidates;
}

/**
 * The first free key for `name`: valid (INV-03), not reserved, and not taken. `undefined` when
 * the name suggests none, so the user picks one.
 */
export function suggestTeamKey(
  name: string,
  isTaken: (key: string) => boolean = () => false,
): string | undefined {
  return teamKeyCandidates(name).find((key) => teamKeyProblem(key) === undefined && !isTaken(key));
}
