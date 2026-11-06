/**
 * "Did you mean" for `UNKNOWN_OPERATION` (SPEC-003 §6 step 1): up to three names within a
 * small edit distance of the request; failing that, names in the same domain.
 */
export function nearestNames(name: string, candidates: readonly string[], limit = 3): string[] {
  const target = name.toLowerCase();
  const maxDistance = Math.max(2, Math.floor(target.length / 4));
  const scored = candidates
    .map((candidate) => ({ candidate, distance: editDistance(target, candidate.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));

  const close = scored.filter(({ distance }) => distance <= maxDistance);
  const domain = target.split('.')[0] ?? '';
  const pool =
    close.length > 0
      ? close
      : scored.filter(({ candidate }) => candidate.toLowerCase().startsWith(`${domain}.`));
  return pool.slice(0, limit).map(({ candidate }) => candidate);
}

/** Levenshtein distance; names are short, so the O(n·m) table is fine. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
