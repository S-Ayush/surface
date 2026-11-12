// PLAN-001 S8: team operation inputs and their optimistic updates (SPEC-003 §8). The client
// drops an optimistic row its model rejects, so every row here is checked against the shared
// client models. Key rules (AC-11) are the handler's: server/test/team-handlers.test.ts.
import { NEW_TEAM_SETTINGS, isUuid } from '@surface/domain';
import { PRODUCTION_MODELS } from '@surface/domain/model';
import { describe, expect, it } from 'vitest';
import type { OptimisticStore, StoreRow } from '../optimistic.js';
import {
  teamAddMember,
  teamCreate,
  teamJoin,
  teamLeave,
  teamRemoveMember,
  teamUpdate,
} from './team.js';

const ME = '0192f0c1-7e5a-7b3c-9d4e-000000000001';
const IRIS = '0192f0c1-7e5a-7b3c-9d4e-000000000002';
const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const BACKLOG = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
const NEW_TEAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000f1';
const NOW = new Date('2026-11-07T10:00:00.000Z');
const AT = NOW.toISOString();

const MODELS = new Map<string, (typeof PRODUCTION_MODELS)[number]>(
  PRODUCTION_MODELS.map((m) => [m.name, m]),
);

/** An in-memory store: `me`, team keys and emails resolve like the client's; rows must parse. */
function fakeStore(): OptimisticStore & { rows: Map<string, Map<string, StoreRow>> } {
  const rows = new Map<string, Map<string, StoreRow>>();
  const table = (model: string) => {
    let t = rows.get(model);
    if (!t) rows.set(model, (t = new Map<string, StoreRow>()));
    return t;
  };
  const find = (model: string, ref: string): StoreRow | undefined => {
    if (isUuid(ref)) return table(model).get(ref);
    if (model === 'User' && ref === 'me') return table(model).get(ME);
    return [...table(model).values()].find(
      (row) => row['key'] === ref || row['email'] === ref || row['displayName'] === ref,
    );
  };
  const put = (model: string, row: StoreRow) => {
    const def = MODELS.get(model);
    if (!def) throw new Error(`unknown model ${model}`);
    const parsed: StoreRow = def.rowSchema.parse(row);
    const id = parsed['id'];
    if (typeof id !== 'string') throw new Error('row without id');
    table(model).set(id, parsed);
  };
  return {
    rows,
    now: NOW,
    get: find,
    insert: put,
    patch: (model, ref, changes) => {
      const row = find(model, ref);
      if (row) put(model, { ...row, ...changes });
    },
    find: (model, fields) =>
      [...table(model).values()].filter((row) =>
        Object.entries(fields).every(([field, value]) => row[field] === value),
      ),
    archive: () => undefined,
    unarchive: () => undefined,
    remove: (model, ref) => {
      const row = find(model, ref);
      const id = row?.['id'];
      if (typeof id === 'string') table(model).delete(id);
    },
  };
}

const basics = { groups: ['workspace'], createdAt: AT, updatedAt: AT };

function seeded() {
  const store = fakeStore();
  const user = (id: string, name: string, timezone: string) =>
    store.insert('User', {
      ...basics,
      id,
      email: `${name}@example.com`,
      name,
      displayName: name,
      avatarFileId: null,
      timezone,
      role: 'member',
      active: true,
    });
  user(ME, 'ada', 'Europe/Berlin');
  user(IRIS, 'iris', 'UTC');
  store.insert('Team', {
    ...NEW_TEAM_SETTINGS,
    ...basics,
    id: ENG,
    key: 'ENG',
    name: 'Engineering',
    icon: null,
    defaultStatusId: BACKLOG,
  });
  return store;
}

/** The memberships in the store, as `team/user` pairs. */
const memberships = (store: ReturnType<typeof seeded>) =>
  [...(store.rows.get('TeamMembership')?.values() ?? [])].map(
    (m) => `${String(m['teamId'])}/${String(m['userId'])}`,
  );

describe('team inputs', () => {
  it('trims names, uppercases keys and stores canonical time zones', () => {
    expect(
      teamCreate.input.parse({ name: '  Mobile  ', key: ' mp ', timezone: 'europe/berlin' }),
    ).toMatchObject({ name: 'Mobile', key: 'MP', timezone: 'Europe/Berlin' });
  });

  it('rejects an empty name, legacy time zones and unknown colors', () => {
    expect(teamCreate.input.safeParse({ name: '  ' }).error?.issues[0]?.message).toBe(
      'Team name is required, like Engineering',
    );
    expect(teamUpdate.input.safeParse({ team: 'ENG', timezone: 'PST' }).success).toBe(false);
    expect(teamUpdate.input.safeParse({ team: 'ENG', color: 'purple' }).success).toBe(false);
  });

  it('takes a UUIDv7 as the new team’s id (SPEC-003 §8)', () => {
    expect(teamCreate.input.safeParse({ id: NEW_TEAM, name: 'Mobile' }).success).toBe(true);
    for (const id of [
      '2f1c7c4e-1d2b-4c1a-8f00-2d6a3b4c5d6e',
      '00000000-0000-0000-0000-000000000000',
    ]) {
      expect(teamCreate.input.safeParse({ id, name: 'Mobile' }).error?.issues[0]?.message).toBe(
        'Use a UUIDv7 for id, or leave it out and the server makes one',
      );
    }
  });

  it('flags removing a member as destructive, and nothing else', () => {
    expect(teamRemoveMember.destructive).toBe(true);
    for (const op of [teamCreate, teamUpdate, teamJoin, teamLeave, teamAddMember]) {
      expect(op.destructive).toBe(false);
    }
  });
});

describe('team.create optimistic', () => {
  const input = teamCreate.input.parse({ id: NEW_TEAM, name: 'Mobile Platform', key: 'MP' });

  it('shows the team with the server’s settings, and me as a member', () => {
    const store = seeded();
    teamCreate.optimistic?.(store, input);
    expect(store.rows.get('Team')?.get(NEW_TEAM)).toMatchObject({
      ...NEW_TEAM_SETTINGS,
      key: 'MP',
      name: 'Mobile Platform',
      // The creator's time zone (SPEC-001 §3.7).
      timezone: 'Europe/Berlin',
      groups: ['workspace'],
      createdAt: AT,
    });
    expect(memberships(store)).toEqual([`${NEW_TEAM}/${ME}`]);
  });

  it('leaves the statuses to the server (§8: server-computed rows are not predicted)', () => {
    const store = seeded();
    teamCreate.optimistic?.(store, input);
    expect(store.rows.get('WorkflowStatus')).toBeUndefined();
  });

  it('is the same on every replay', () => {
    const [a, b] = [seeded(), seeded()];
    teamCreate.optimistic?.(a, input);
    teamCreate.optimistic?.(b, input);
    expect(a.rows).toEqual(b.rows);
  });

  it('predicts nothing without an id or a valid key: the server decides', () => {
    for (const partial of [
      { name: 'Mobile', key: 'MO' },
      { id: NEW_TEAM, name: 'Mobile' },
      { id: NEW_TEAM, name: 'Mobile', key: 'API' },
      { id: NEW_TEAM, name: 'Mobile', key: 'M1' },
    ]) {
      const store = seeded();
      teamCreate.optimistic?.(store, teamCreate.input.parse(partial));
      expect(store.rows.get('Team')?.size).toBe(1);
    }
  });
});

describe('team.update optimistic', () => {
  it('patches only the given settings, and clears the icon with null', () => {
    const store = seeded();
    teamUpdate.optimistic?.(
      store,
      teamUpdate.input.parse({ team: 'ENG', name: 'Eng', icon: null }),
    );
    expect(store.rows.get('Team')?.get(ENG)).toMatchObject({
      name: 'Eng',
      icon: null,
      color: NEW_TEAM_SETTINGS.color,
      updatedAt: AT,
    });
  });
});

describe('membership optimistic updates', () => {
  it('join shows me as a member once', () => {
    const store = seeded();
    teamJoin.optimistic?.(store, { team: 'ENG' });
    teamJoin.optimistic?.(store, { team: 'ENG' });
    expect(memberships(store)).toEqual([`${ENG}/${ME}`]);
  });

  it('addMember shows the named user as a member', () => {
    const store = seeded();
    teamAddMember.optimistic?.(store, { team: 'ENG', user: 'iris@example.com' });
    expect(memberships(store)).toEqual([`${ENG}/${IRIS}`]);
  });

  it('do nothing for an unknown team', () => {
    const store = seeded();
    teamJoin.optimistic?.(store, { team: 'ZZZ' });
    teamAddMember.optimistic?.(store, { team: 'ZZZ', user: 'me' });
    expect(memberships(store)).toEqual([]);
  });

  it('leave hides my membership, and only mine', () => {
    const store = seeded();
    teamJoin.optimistic?.(store, { team: 'ENG' });
    teamAddMember.optimistic?.(store, { team: 'ENG', user: 'iris@example.com' });
    teamLeave.optimistic?.(store, { team: 'ENG' });
    expect(memberships(store)).toEqual([`${ENG}/${IRIS}`]);
    // Again, as a replay or a second click: nothing more to hide.
    teamLeave.optimistic?.(store, { team: 'ENG' });
    expect(memberships(store)).toEqual([`${ENG}/${IRIS}`]);
  });

  it('removeMember hides the named user’s membership, and a non-member changes nothing', () => {
    const store = seeded();
    teamJoin.optimistic?.(store, { team: 'ENG' });
    teamAddMember.optimistic?.(store, { team: 'ENG', user: 'iris@example.com' });
    teamRemoveMember.optimistic?.(store, { team: 'ENG', user: 'iris@example.com' });
    expect(memberships(store)).toEqual([`${ENG}/${ME}`]);
    teamRemoveMember.optimistic?.(store, { team: 'ENG', user: 'iris@example.com' });
    expect(memberships(store)).toEqual([`${ENG}/${ME}`]);
  });

  it('the last member of a public team may leave (E12)', () => {
    const store = seeded();
    teamJoin.optimistic?.(store, { team: 'ENG' });
    teamLeave.optimistic?.(store, { team: 'ENG' });
    expect(memberships(store)).toEqual([]);
  });

  it('keep a private team’s last member, as the server refuses (E12, D3)', () => {
    const store = seeded();
    teamJoin.optimistic?.(store, { team: 'ENG' });
    store.patch('Team', 'ENG', { private: true });
    teamLeave.optimistic?.(store, { team: 'ENG' });
    teamRemoveMember.optimistic?.(store, { team: 'ENG', user: 'me' });
    expect(memberships(store)).toEqual([`${ENG}/${ME}`]);
    // With someone else in it, the membership ends.
    teamAddMember.optimistic?.(store, { team: 'ENG', user: 'iris@example.com' });
    teamLeave.optimistic?.(store, { team: 'ENG' });
    expect(memberships(store)).toEqual([`${ENG}/${IRIS}`]);
  });

  it('show nothing for a private team I am not in, as the server answers NOT_FOUND', () => {
    const store = seeded();
    teamAddMember.optimistic?.(store, { team: 'ENG', user: 'iris@example.com' });
    store.patch('Team', 'ENG', { private: true });
    teamJoin.optimistic?.(store, { team: 'ENG' });
    teamAddMember.optimistic?.(store, { team: 'ENG', user: 'me' });
    teamRemoveMember.optimistic?.(store, { team: 'ENG', user: 'iris@example.com' });
    expect(memberships(store)).toEqual([`${ENG}/${IRIS}`]);
  });

  it('show nothing more for a private team once I have left it', () => {
    const store = seeded();
    teamJoin.optimistic?.(store, { team: 'ENG' });
    teamAddMember.optimistic?.(store, { team: 'ENG', user: 'iris@example.com' });
    store.patch('Team', 'ENG', { private: true });
    teamLeave.optimistic?.(store, { team: 'ENG' });
    teamAddMember.optimistic?.(store, { team: 'ENG', user: 'me' });
    teamRemoveMember.optimistic?.(store, { team: 'ENG', user: 'iris@example.com' });
    expect(memberships(store)).toEqual([`${ENG}/${IRIS}`]);
  });

  it('leave and removeMember do nothing for a team the store lacks', () => {
    const store = seeded();
    teamJoin.optimistic?.(store, { team: 'ENG' });
    teamLeave.optimistic?.(store, { team: 'SEC' });
    teamRemoveMember.optimistic?.(store, { team: 'SEC', user: 'me' });
    expect(memberships(store)).toEqual([`${ENG}/${ME}`]);
  });
});
