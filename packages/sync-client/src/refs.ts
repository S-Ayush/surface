/**
 * Client reference resolution (SPEC-003 §4, PLAN-002 S8) over the replica, for
 * `optimistic()` and command-menu parsing. It follows the server's rules
 * (`apps/server/src/executor/refs/sources.ts`) so a reference resolves to the
 * same row on both sides:
 * - names match case-insensitively, and an exact-case match wins over other
 *   case variants; several matches are ambiguous;
 * - statuses resolve within a team, and a status without one is not found;
 * - a team's labels win over workspace labels with the same name, and without
 *   a team only workspace labels match;
 * - deactivated users match only with `allowInactive`.
 *
 * Visibility needs no check here: the replica only holds rows this user may
 * see, so an invisible row is simply `notFound`, as on the server.
 *
 * Teams, users, statuses and labels number in the hundreds at most (NFR
 * reference scale), so lookups scan the model rather than needing indexes.
 */
import type {
  ClientRefResolver,
  RefEntity,
  RefLookup,
  RefLookupOptions,
  RefType,
} from '@surface/domain';
import { parseLabelRef, parseNamedRef, parseTeamRef, parseUserRef } from '@surface/domain';
import { rowOf } from './instance.js';
import type { ReadonlyPool } from './pool.js';

/** The synced model behind each reference type that exists in M0 (PLAN-001). */
export const REF_MODELS = {
  TeamRef: 'Team',
  UserRef: 'User',
  StatusRef: 'WorkflowStatus',
  LabelRef: 'Label',
} as const satisfies Partial<Record<RefType, string>>;

const NOT_FOUND: RefLookup = { status: 'notFound' };

/** The rows references resolve against: the replica, or the overlay being built. */
export interface RefSource {
  /** Every row of a model (an unknown model has none). */
  readonly rows: (model: string) => RefEntity[];
  readonly row: (model: string, id: string) => RefEntity | undefined;
}

/** The replica as views see it. */
export function poolRefSource(pool: ReadonlyPool): RefSource {
  const known = (model: string) => pool.models.some((def) => def.name === model);
  return {
    rows: (model) => (known(model) ? pool.all(model).map(rowOf) : []),
    row: (model, id) => {
      const instance = known(model) ? pool.get(model, id) : undefined;
      return instance && rowOf(instance);
    },
  };
}

/** `me` is the signed-in user's id. */
export function createClientRefResolver(
  source: RefSource,
  me: () => string | undefined,
): ClientRefResolver {
  const rows = (model: string) => source.rows(model);
  const byId = (model: string, id: string) => source.row(model, id);

  const found = (entity: RefEntity | undefined): RefLookup =>
    entity ? { status: 'found', entity } : NOT_FOUND;

  return {
    resolve(type, value, options = {}) {
      if (typeof value !== 'string') return NOT_FOUND;
      switch (type) {
        case 'TeamRef':
          return found(team(value));
        case 'UserRef':
          return user(value, options);
        case 'StatusRef':
          return status(value, options);
        case 'LabelRef':
          return label(value, options);
        // Invites are never in the replica: the server resolves them (PLAN-001 S5).
        case 'InviteRef':
          return NOT_FOUND;
        // Sessions are server-side only (`session.list`), so the server resolves them (PLAN-001 S6).
        case 'SessionRef':
          return NOT_FOUND;
        // Their models arrive with later milestones; until then nothing matches. Files are
        // server-only in M0 (avatars, the logo: PLAN-001 S6) and may sync with attachments (M1).
        case 'FileRef':
        case 'IssueRef':
        case 'ProjectRef':
        case 'CycleRef':
        case 'InitiativeRef':
        case 'DocumentRef':
        case 'ViewRef':
          return NOT_FOUND;
      }
    },
  };

  function team(value: string): RefEntity | undefined {
    const ref = parseTeamRef(value);
    if (ref?.by === 'id') return byId(REF_MODELS.TeamRef, ref.id);
    if (ref?.by === 'key') return rows(REF_MODELS.TeamRef).find((row) => row.key === ref.key);
    return undefined;
  }

  function user(value: string, options: RefLookupOptions): RefLookup {
    const ref = parseUserRef(value);
    let matches: RefEntity[] = [];
    if (ref?.by === 'id' || ref?.by === 'me') {
      const id = ref.by === 'id' ? ref.id : me();
      const row = id === undefined ? undefined : byId(REF_MODELS.UserRef, id);
      matches = row ? [row] : [];
    } else if (ref?.by === 'email') {
      matches = rows(REF_MODELS.UserRef).filter((row) => row.email === ref.email);
    } else if (ref?.by === 'name') {
      matches = sortByName(sameName(rows(REF_MODELS.UserRef), 'displayName', ref.name));
    }
    const picked = pick(matches, (row) => row.displayName === value.trim());
    if (picked.status !== 'found') return picked;
    return picked.entity.active === false && !options.allowInactive ? NOT_FOUND : picked;
  }

  function status(value: string, options: RefLookupOptions): RefLookup {
    const teamId = options.scopeTeamId;
    if (teamId === undefined) return NOT_FOUND;
    const ref = parseNamedRef(value);
    if (ref?.by === 'id') {
      const row = byId(REF_MODELS.StatusRef, ref.id);
      return found(row?.teamId === teamId ? row : undefined);
    }
    if (ref?.by !== 'name') return NOT_FOUND;
    const inTeam = rows(REF_MODELS.StatusRef).filter((row) => row.teamId === teamId);
    return pick(sortByName(sameName(inTeam, 'name', ref.name)), (row) => row.name === value.trim());
  }

  function label(value: string, options: RefLookupOptions): RefLookup {
    const teamId = options.scopeTeamId ?? null;
    const usable = (row: RefEntity) => row.teamId === null || row.teamId === teamId;
    const ref = parseLabelRef(value);
    // SPEC-010 §6: an id resolves to any label the replica holds, with or without a team.
    if (ref?.by === 'id') return found(byId(REF_MODELS.LabelRef, ref.id));
    if (ref?.by !== 'name' && ref?.by !== 'groupLabel') return NOT_FOUND;
    let matches = sameName(rows(REF_MODELS.LabelRef).filter(usable), 'name', ref.name);
    if (ref.by === 'groupLabel') {
      const wanted = ref.group.toLowerCase();
      matches = matches.filter((row) => {
        const parent = typeof row.parentId === 'string' ? byId('Label', row.parentId) : undefined;
        return typeof parent?.name === 'string' && parent.name.toLowerCase() === wanted;
      });
    }
    // SPEC-003 §4: the team's labels win over workspace labels with the same name.
    const teamRows = matches.filter((row) => row.teamId !== null);
    const candidates = sortLabels(teamRows.length > 0 ? teamRows : matches);
    return pick(candidates, (row) => row.name === ref.name);
  }

  /** Sorted like the server's `ORDER BY p.name NULLS FIRST, l.name, l.id` (`COLLATE "C"`). */
  function sortLabels(labels: RefEntity[]): RefEntity[] {
    const group = (row: RefEntity): string | undefined => {
      const parent = typeof row.parentId === 'string' ? byId('Label', row.parentId) : undefined;
      return typeof parent?.name === 'string' ? parent.name : undefined;
    };
    return labels.sort(
      (a, b) =>
        compareNullsFirst(group(a), group(b)) ||
        compare(String(a.name), String(b.name)) ||
        compare(a.id, b.id),
    );
  }
}

function sameName(rows: RefEntity[], field: string, name: string): RefEntity[] {
  const wanted = name.toLowerCase();
  return rows.filter((row) => {
    const value = row[field];
    return typeof value === 'string' && value.toLowerCase() === wanted;
  });
}

/** The only match, else the only exact-case match, else ambiguous (server `pickByName`). */
function pick(rows: RefEntity[], exact: (row: RefEntity) => boolean): RefLookup {
  const [only] = rows;
  if (only === undefined) return NOT_FOUND;
  if (rows.length === 1) return { status: 'found', entity: only };
  const exactRows = rows.filter(exact);
  const [first] = exactRows;
  if (exactRows.length === 1 && first) return { status: 'found', entity: first };
  return { status: 'ambiguous', candidates: exactRows.length > 1 ? exactRows : rows };
}

/** Sorted like `ORDER BY name COLLATE "C", id`: by UTF-16 code unit, which matches for BMP text. */
function sortByName(rows: RefEntity[]): RefEntity[] {
  const name = (row: RefEntity) => String(row.displayName ?? row.name);
  return rows.sort((a, b) => compare(name(a), name(b)) || compare(a.id, b.id));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareNullsFirst(a: string | undefined, b: string | undefined): number {
  if (a === undefined) return b === undefined ? 0 : -1;
  return b === undefined ? 1 : compare(a, b);
}
