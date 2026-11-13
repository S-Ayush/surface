/**
 * Team operations (SPEC-001 §3.7, §6.2; PLAN-001 S8). Permissions follow permissions.md §3.2:
 * anyone creates, joins or leaves a (public) team; members and Admins manage settings and
 * membership. A private team is invisible to non-members, so every reference to it from one is
 * `NOT_FOUND` before any permission check (the executor resolves references first).
 *
 * Optimistic updates (SPEC-003 §8): server-computed rows are not predicted, so `team.create`
 * shows the team and my membership but not its statuses. `team.leave` and `team.removeMember`
 * find the membership by team and user (`store.find`) and hide it, unless the server would refuse
 * (a private team's last member, SPEC-001 E12, D3).
 */
import {
  COLOR_HUES,
  ESTIMATE_SCALES,
  NEW_TEAM_SETTINGS,
  canEndMembership,
  RESERVED_TEAM_KEYS,
  type PermissionPredicates,
  type ResolvedRefs,
  DEFAULT_STATUS_CATEGORIES,
  StatusRef,
  TeamRef,
  UserRef,
  WORKSPACE_GROUP,
  canonicalTimeZone,
  teamKeyProblem,
  timeZoneProblem,
} from '@surface/domain';
import { z } from 'zod';
import { defineOperation } from '../define.js';
import { Timestamp } from './shared.js';
import type { OptimisticStore, StoreRow } from '../optimistic.js';

export const TEAM_NAME_MAX = 80;

const TeamName = z
  .string()
  .trim()
  .min(1, 'Team name is required, like Engineering')
  .max(TEAM_NAME_MAX, `Team name must be ${TEAM_NAME_MAX} characters or fewer`);

/**
 * Format, reserved keys and uniqueness (INV-03) are checked by the handler, so every bad key
 * gets the next free suggestion for the name (SPEC-001 E11, AC-11).
 */
const TeamKey = z
  .string()
  .trim()
  .toUpperCase()
  .max(32)
  .meta({
    description: `Team key: 2–5 letters (stored uppercase), like ENG. Not ${RESERVED_TEAM_KEYS.join(', ')}`,
  });

const TimeZone = z
  .string()
  .trim()
  .superRefine((zone, ctx) => {
    const problem = timeZoneProblem(zone);
    if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
  })
  .overwrite(canonicalTimeZone)
  .meta({ description: 'IANA time zone, like Europe/Berlin' });

/** An icon name or emoji; null clears it. */
const TeamIcon = z.string().trim().min(1).max(64).nullable();

export const TeamSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  color: z.enum(COLOR_HUES),
  timezone: z.string(),
  private: z.boolean(),
  defaultStatusId: z.uuid(),
  /** Estimate settings (SPEC-010 §4.3); `team.setEstimates` (PLAN-010 S4) changes them. */
  estimateScale: z.enum(ESTIMATE_SCALES),
  estimateExtended: z.boolean(),
  estimateAllowZero: z.boolean(),
  estimateCountUnestimatedAsOne: z.boolean(),
  /**
   * The Canceled status auto-close moves stale issues to, or null while auto-close is off
   * (SPEC-015 §3.2). PLAN-015 S3's `team.updateAutomations` sets it.
   */
  autoCloseStatusId: z.uuid().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

/** The state of one person's membership of one team after a membership operation. */
export const TeamMembershipStateSchema = z.object({
  teamId: z.uuid(),
  teamKey: z.string(),
  userId: z.uuid(),
  member: z.boolean(),
});

// ---------------------------------------------------------------------------------------------
// Optimistic helpers

/** A row's id, when the row exists. */
function idOf(row: StoreRow | undefined): string | undefined {
  const id = row?.['id'];
  return typeof id === 'string' ? id : undefined;
}

/**
 * An id for a row that lives only in the overlay until the server's row replaces it, the same
 * on every replay of the mutation (§8: deterministic). Never sent to the server. The XOR of two
 * UUIDs, stamped as version 8 so the client model's uuid check accepts it.
 */
function overlayId(a: string, b: string): string {
  const x = a.replaceAll('-', '').toLowerCase();
  const y = b.replaceAll('-', '').toLowerCase();
  const nibbles = Array.from(x, (char, i) => parseInt(char, 16) ^ parseInt(y.charAt(i), 16));
  nibbles[12] = 0x8;
  nibbles[16] = 0x8 | ((nibbles[16] ?? 0) & 0x3);
  const hex = nibbles.map((n) => n.toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The fields every client row carries: public teams are in the workspace group (SPEC-001 §5). */
function rowBasics(store: OptimisticStore) {
  const at = store.now.toISOString();
  return { groups: [WORKSPACE_GROUP], createdAt: at, updatedAt: at };
}

/** Shows a membership until the server's row arrives; a member already changes nothing. */
function insertMembership(store: OptimisticStore, teamId: string, userId: string): void {
  // The server's row has its own id, so look by team and user, not by the overlay id.
  if (store.find('TeamMembership', { teamId, userId }).length > 0) return;
  const id = overlayId(teamId, userId);
  store.insert('TeamMembership', {
    ...rowBasics(store),
    id,
    teamId,
    userId,
    triageResponsible: false,
  });
}

/**
 * The team `ref` names, as the server would see it for me: a private team is visible to its
 * members only (permissions.md §5), so once I have left one in a pending mutation, later ones
 * naming it predict nothing, as the server answers them `NOT_FOUND`.
 */
function visibleTeam(store: OptimisticStore, ref: string, me: string | undefined) {
  const team = store.get('Team', ref);
  const teamId = idOf(team);
  if (team === undefined || teamId === undefined) return undefined;
  if (team['private'] === false) return team;
  if (me === undefined) return undefined;
  return store.find('TeamMembership', { teamId, userId: me }).length > 0 ? team : undefined;
}

/**
 * Hides `userId`'s membership of `team` until the server confirms, as `removeMember` on the
 * server does: a non-member changes nothing, and the last member of a private team stays (E12,
 * D3: the server refuses, so nothing is predicted). A team the store lacks (a private team the
 * user isn't in) predicts nothing. Only removes: never shows a row the store didn't have.
 */
function removeMembership(
  store: OptimisticStore,
  team: StoreRow | undefined,
  userId: string | undefined,
): void {
  const teamId = idOf(team);
  if (team === undefined || teamId === undefined || userId === undefined) return;
  const members = store.find('TeamMembership', { teamId });
  const mine = members.filter((membership) => membership['userId'] === userId);
  if (mine.length === 0) return;
  // People, not rows: a pending join's overlay row may sit next to the server's own row.
  const people = new Set(members.map((membership) => membership['userId'])).size;
  // Anything but a known public team counts as private: refusing to predict is the safe side.
  if (!canEndMembership({ private: team['private'] !== false }, people)) return;
  for (const membership of mine) {
    const id = idOf(membership);
    if (id !== undefined) store.remove('TeamMembership', id);
  }
}

// ---------------------------------------------------------------------------------------------

export const teamSuggestKey = defineOperation({
  name: 'team.suggestKey',
  kind: 'query',
  domain: 'team',
  summary: 'Suggest a key for a new team',
  description:
    'Suggests a free team key from a team name: the initials of its words, or the first letters of one word (Engineering → ENG). Returns null when the name suggests none.',
  keywords: ['suggest team key', 'what key for a team', 'team identifier prefix'],
  input: z.object({ name: TeamName }),
  output: z.object({ key: z.string().nullable() }),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ name: 'Mobile Platform' }],
});

export const teamCreate = defineOperation({
  name: 'team.create',
  kind: 'mutation',
  domain: 'team',
  summary: 'Create a team',
  description:
    'Creates a public team with the default workflow (Backlog is the default status) and makes you a member. The key defaults to a suggestion from the name; the time zone to yours. A taken, reserved or malformed key is an error that suggests another.',
  keywords: ['create team', 'new team', 'add a team'],
  input: z.object({
    /** Client-generated UUIDv7 (SPEC-003 §8, E7); generated by the server when absent. */
    id: z
      .uuid({
        version: 'v7',
        error: 'Use a UUIDv7 for id, or leave it out and the server makes one',
      })
      .optional(),
    name: TeamName,
    key: TeamKey.optional(),
    icon: TeamIcon.optional(),
    color: z.enum(COLOR_HUES).optional(),
    timezone: TimeZone.optional(),
  }),
  output: TeamSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ name: 'Mobile Platform', key: 'MP', color: 'blue' }],
  ui: { title: 'Create team…', icon: 'plus', contexts: ['global'], shortcut: null },
  optimistic: (store, input) => {
    // Without an id or a valid key the server decides; nothing to predict.
    if (input.id === undefined || input.key === undefined) return;
    if (teamKeyProblem(input.key) !== undefined) return;
    const me = store.get('User', 'me');
    const myZone = me?.['timezone'];
    store.insert('Team', {
      ...NEW_TEAM_SETTINGS,
      ...rowBasics(store),
      id: input.id,
      key: input.key,
      name: input.name,
      icon: input.icon ?? null,
      color: input.color ?? NEW_TEAM_SETTINGS.color,
      timezone:
        input.timezone ?? (typeof myZone === 'string' ? myZone : NEW_TEAM_SETTINGS.timezone),
      // The Backlog status is the server's to create (§8: not simulated); a placeholder until
      // the team's row arrives.
      defaultStatusId: input.id,
    });
    const myId = idOf(me);
    if (myId !== undefined) insertMembership(store, input.id, myId);
  },
});

export const teamUpdate = defineOperation({
  name: 'team.update',
  kind: 'mutation',
  domain: 'team',
  summary: 'Update a team’s name, icon, color or time zone',
  description:
    'Changes the given settings of a team: name, icon (null clears it), color, time zone. Accepts a team key like ENG or a team id. The key cannot change.',
  keywords: ['rename team', 'change team color', 'set team time zone', 'edit team settings'],
  input: z.object({
    team: TeamRef,
    name: TeamName.optional(),
    icon: TeamIcon.optional(),
    color: z.enum(COLOR_HUES).optional(),
    timezone: TimeZone.optional(),
  }),
  output: TeamSchema,
  ui: { title: 'Rename team…', icon: 'pencil', contexts: ['team'], shortcut: null },
  permission: (p, { team }) => p.admin() || p.teamMember(team),
  destructive: false,
  examples: [{ team: 'ENG', name: 'Engineering', color: 'blue' }],
  optimistic: (store, input) => {
    const { team, ...settings } = input;
    const changes = Object.fromEntries(
      Object.entries(settings).filter(([, value]) => value !== undefined),
    );
    store.patch('Team', team, { ...changes, updatedAt: store.now.toISOString() });
  },
});

export const teamJoin = defineOperation({
  name: 'team.join',
  kind: 'mutation',
  domain: 'team',
  summary: 'Join a team',
  description:
    'Makes you a member of a public team. Joining a team you are already in changes nothing. Accepts a team key like ENG or a team id.',
  keywords: ['join team', 'become a team member', 'add me to team'],
  input: z.object({ team: TeamRef }),
  output: TeamMembershipStateSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ team: 'ENG' }],
  // A team page's command menu (SPEC-005 §4.1). For a member it changes nothing.
  ui: { title: 'Join team', icon: 'user-plus', contexts: ['team'], shortcut: null },
  optimistic: (store, input) => {
    const myId = idOf(store.get('User', 'me'));
    const teamId = idOf(visibleTeam(store, input.team, myId));
    if (teamId !== undefined && myId !== undefined) insertMembership(store, teamId, myId);
  },
});

export const teamLeave = defineOperation({
  name: 'team.leave',
  kind: 'mutation',
  domain: 'team',
  summary: 'Leave a team',
  description:
    'Ends your membership of a team; leaving a team you are not in changes nothing. The team stays, and anyone can join a public team again; the last member of a private team cannot leave. Accepts a team key like ENG or a team id.',
  keywords: ['leave team', 'quit team', 'remove me from team'],
  input: z.object({ team: TeamRef }),
  output: TeamMembershipStateSchema,
  // Not `teamMember`: a leave replayed after someone removed you must still succeed.
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ team: 'ENG' }],
  // A team page's command menu (SPEC-005 §4.1). It asks first (features/teams/commands.ts).
  ui: { title: 'Leave team…', icon: 'log-out', contexts: ['team'], shortcut: null },
  optimistic: (store, input) => {
    const myId = idOf(store.get('User', 'me'));
    removeMembership(store, visibleTeam(store, input.team, myId), myId);
  },
});

export const teamAddMember = defineOperation({
  name: 'team.addMember',
  kind: 'mutation',
  domain: 'team',
  summary: 'Add someone to a team',
  description:
    'Makes a person a member of a team; adding a member changes nothing. Accepts a team key like ENG or a team id, and a user email, display name, "me" or id.',
  keywords: ['add member to team', 'add person to team', 'invite colleague to team'],
  input: z.object({ team: TeamRef, user: UserRef }),
  output: TeamMembershipStateSchema,
  permission: (p, { team }) => p.admin() || p.teamMember(team),
  destructive: false,
  examples: [{ team: 'ENG', user: 'iris@example.com' }],
  optimistic: (store, input) => {
    const teamId = idOf(visibleTeam(store, input.team, idOf(store.get('User', 'me'))));
    const userId = idOf(store.get('User', input.user));
    if (teamId !== undefined && userId !== undefined) insertMembership(store, teamId, userId);
  },
});

export const teamRemoveMember = defineOperation({
  name: 'team.removeMember',
  kind: 'mutation',
  domain: 'team',
  summary: 'Remove someone from a team',
  description:
    'Ends a person’s membership of a team; removing a non-member changes nothing. The last member of a private team cannot be removed. Accepts a team key like ENG or a team id, and a user email, display name, "me" or id.',
  keywords: ['remove member from team', 'take person off team', 'kick from team'],
  input: z.object({ team: TeamRef, user: UserRef }),
  output: TeamMembershipStateSchema,
  permission: (p, { team }) => p.admin() || p.teamMember(team),
  destructive: true,
  examples: [{ team: 'ENG', user: 'iris@example.com' }],
  // A team page's command menu: a page of the team's members (features/teams/commands.ts).
  ui: { title: 'Remove member…', icon: 'user-minus', contexts: ['team'], shortcut: null },
  optimistic: (store, input) => {
    const team = visibleTeam(store, input.team, idOf(store.get('User', 'me')));
    removeMembership(store, team, idOf(store.get('User', input.user)));
  },
});

// ---------------------------------------------------------------------------------------------
// Default status and estimate settings (SPEC-010 §6; PLAN-010 S4)

/**
 * Whether the actor may change the workflow of the status's own team (§5). A status ref resolves
 * inside the named team only, but the check does not trust the named team: it uses the resolved
 * status's `teamId`, as `label.update` does, so naming ENG can't unlock a DES status.
 */
function mayChangeDefault(p: PermissionPredicates, refs: ResolvedRefs): boolean {
  const status = refs['status'];
  const named = refs['team'];
  if (status === undefined || !('id' in status)) return p.admin() || p.teamMember(named);
  const teamId = status['teamId'];
  if (typeof teamId !== 'string') return false;
  // The resolver scopes a status to the named team, so the fallback can't happen today: defence in depth.
  const own = named !== undefined && 'id' in named && named.id === teamId ? named : { id: teamId };
  return p.admin() || p.teamMember(own);
}

export const teamSetDefaultStatus = defineOperation({
  name: 'team.setDefaultStatus',
  kind: 'mutation',
  domain: 'team',
  summary: 'Set a team’s default status',
  description:
    'Makes a status the one new issues start in. Only a Backlog or Unstarted status of the team can be the default. Accepts a team key like ENG or a team id, and a status name in that team or a status id.',
  keywords: ['default status', 'set default status', 'initial status for new issues'],
  input: z.object({ team: TeamRef, status: StatusRef }),
  output: TeamSchema,
  ui: { title: 'Set default status…', icon: 'circle-dot', contexts: ['team'], shortcut: null },
  permission: (p, refs) => mayChangeDefault(p, refs),
  destructive: false,
  examples: [{ team: 'ENG', status: 'Todo' }],
  optimistic: (store, input) => {
    const team = store.get('Team', input.team);
    const teamId = idOf(team);
    if (team === undefined || teamId === undefined) return;
    const lower = input.status.trim().toLowerCase();
    const statuses = store.find('WorkflowStatus', { teamId });
    const status =
      statuses.find((s) => s['id'] === input.status) ??
      statuses.find((s) => String(s['name']).toLowerCase() === lower);
    const id = idOf(status);
    const category = status?.['category'];
    // The server refuses other categories (INV-05), so nothing is predicted for them. The id is
    // the resolved one, never the ref text.
    if (id === undefined || !DEFAULT_STATUS_CATEGORIES.some((c) => c === category)) return;
    if (team['defaultStatusId'] === id) return;
    store.patch('Team', teamId, { defaultStatusId: id, updatedAt: store.now.toISOString() });
  },
});

export const teamSetEstimates = defineOperation({
  name: 'team.setEstimates',
  kind: 'mutation',
  domain: 'team',
  summary: 'Change a team’s estimate settings',
  description:
    'Changes the estimate scale (off, linear, exponential, fibonacci, tshirt) and the Extended, Allow zero and Count unestimated as 1 options; give at least one. Existing issue estimates are never changed: values the new settings do not allow stay and show as numbers. Accepts a team key like ENG or a team id.',
  keywords: [
    'estimate scale',
    'enable estimates',
    'story points',
    't-shirt sizes',
    'turn off estimates',
  ],
  input: z
    .object({
      team: TeamRef,
      scale: z.enum(ESTIMATE_SCALES).optional(),
      extended: z.boolean().optional(),
      allowZero: z.boolean().optional(),
      countUnestimatedAsOne: z.boolean().optional(),
    })
    .refine(
      (v) =>
        v.scale !== undefined ||
        v.extended !== undefined ||
        v.allowZero !== undefined ||
        v.countUnestimatedAsOne !== undefined,
      {
        message:
          'Give at least one of scale, extended, allowZero and countUnestimatedAsOne to change',
        path: ['scale'],
      },
    ),
  output: TeamSchema,
  ui: { title: 'Change estimate scale…', icon: 'gauge', contexts: ['team'], shortcut: null },
  permission: (p, { team }) => p.admin() || p.teamMember(team),
  destructive: false,
  examples: [{ team: 'ENG', scale: 'fibonacci', extended: true }],
  optimistic: (store, input) => {
    const teamId = idOf(store.get('Team', input.team));
    if (teamId === undefined) return;
    const wanted: Record<string, unknown> = {
      estimateScale: input.scale,
      estimateExtended: input.extended,
      estimateAllowZero: input.allowZero,
      estimateCountUnestimatedAsOne: input.countUnestimatedAsOne,
    };
    const saved = store.get('Team', teamId) ?? {};
    // Only what differs, as the server writes it.
    const changes = Object.fromEntries(
      Object.entries(wanted).filter(([k, v]) => v !== undefined && saved[k] !== v),
    );
    if (Object.keys(changes).length === 0) return;
    store.patch('Team', teamId, { ...changes, updatedAt: store.now.toISOString() });
  },
});
