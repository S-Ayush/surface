import { editDistance } from '@surface/operations';

export { editDistance };

/**
 * "Did you mean" for `UNKNOWN_OPERATION` (SPEC-003 §6 step 1): up to three names within a
 * small edit distance of the request; failing that, names in the same domain.
 */
export function nearestNames(name: string, candidates: readonly string[], limit = 3): string[] {
  // Edit distance is O(n·m); names arrive unbounded through MCP bodies (M6). No real name is this long.
  if (name.length > MAX_NAME_LENGTH) return [];
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

const MAX_NAME_LENGTH = 100;
