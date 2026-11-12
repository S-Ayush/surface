// PLAN-001 S8 web half: the create-team and team-settings forms (SPEC-001 §3.7). AC-11 (unit part):
// the key is suggested from the name and checked inline with the server's own words; E11: the
// server's refusal of a key shows on the key field. Also the client's UUIDv7 and how a form waits
// for the server online and not offline.
import { teamKeyIssue, uuidv7 } from '@surface/domain';
import { teamCreate } from '@surface/operations';
import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import {
  createTeamContext,
  createTeamInput,
  createTeamProblems,
  emptyCreateTeamForm,
  hasProblems,
  hasUnsavedChanges,
  placeServerError,
  takenKeys,
  withKey,
  withName,
  withRefusedKey,
} from '../src/features/teams/create-team.js';
import { submitMutation, type MutationStore } from '../src/features/teams/submit.js';
import {
  teamSettingsChanges,
  teamSettingsForm,
  teamSettingsProblems,
  withEdits,
} from '../src/features/teams/team-settings.js';

const taken = takenKeys([{ key: 'ENG' }, { key: 'mp' }]);
const empty = emptyCreateTeamForm('Europe/Berlin');

describe('create team: key suggestion (AC-11)', () => {
  it('suggests a free key as the name is typed, skipping taken keys', () => {
    expect(withName(empty, 'Design', taken).key).toBe('DES');
    expect(withName(empty, 'Engineering', taken).key).toBe('ENGI');
    expect(withName(empty, 'Mobile Platform', taken).key).toBe('MPL');
    expect(withName(empty, 'X', taken).key).toBe('');
  });

  it('keeps a key the user typed, upper-cased; clearing it resumes suggesting', () => {
    const typed = withKey(withName(empty, 'Design', taken), ' dsn ', taken);
    expect(typed).toMatchObject({ key: 'DSN', keyEdited: true });
    expect(withName(typed, 'Design team', taken).key).toBe('DSN');
    expect(withKey(typed, '', taken)).toMatchObject({ key: 'DES', keyEdited: false });
  });

  it('counts archived teams’ keys as taken, since keys stay unique (E11)', () => {
    const teams = [
      { id: 't-eng', key: 'ENG' },
      { id: 't-old', key: 'OLD', $archived: true },
    ];
    const context = createTeamContext(teams, { timezone: 'Asia/Tokyo' });
    expect(context).toEqual({ keys: ['ENG', 'OLD'], myTimezone: 'Asia/Tokyo' });
    expect(withName(empty, 'Oldies', new Set(context.keys)).key).toBe('OLDI');
  });

  it('doesn’t count the team being created as taken while it waits (hand-check bug)', () => {
    // The optimistic insert puts the new team in the store before the server answers.
    const teams = [
      { id: 't-eng', key: 'ENG' },
      { id: 't-new', key: 'PLA' },
    ];
    expect(createTeamContext(teams, undefined, 't-new').keys).toEqual(['ENG']);
    expect(createTeamContext(teams, undefined).keys).toEqual(['ENG', 'PLA']);
    const form = withName(empty, 'Platform', new Set(['ENG']));
    const { keys } = createTeamContext(teams, undefined, 't-new');
    expect(createTeamProblems(form, new Set(keys)).key).toBeUndefined();
  });

  it('has nothing unsaved once submitted, since the change is queued (hand-check bug)', () => {
    const typed = withName(empty, 'Platform', taken);
    expect(hasUnsavedChanges(empty, false)).toBe(false);
    expect(hasUnsavedChanges(typed, false)).toBe(true);
    expect(hasUnsavedChanges({ ...empty, icon: '🎨' }, false)).toBe(true);
    expect(hasUnsavedChanges(typed, true)).toBe(false);
  });

  it('defaults the time zone to the creator’s, or UTC', () => {
    expect(empty.timezone).toBe('Europe/Berlin');
    expect(emptyCreateTeamForm(undefined).timezone).toBe('UTC');
  });
});

describe('create team: inline problems in the server’s words (AC-11, E11)', () => {
  it('accepts a valid form', () => {
    expect(hasProblems(createTeamProblems(withName(empty, 'Design', taken), taken))).toBe(false);
  });

  it('names a taken key and suggests the next free one', () => {
    const form = withKey(withName(empty, 'Engineering', taken), 'ENG', taken);
    expect(createTeamProblems(form, taken).key).toBe(
      'Team key ENG is taken. Try ENGI, or choose another.',
    );
  });

  it('rejects malformed and reserved keys with a suggestion', () => {
    const malformed = withKey(withName(empty, 'Design', taken), 'D3', taken);
    expect(createTeamProblems(malformed, taken).key).toBe(
      'Team key must be 2–5 capital letters, like ENG. Try DES, or choose another.',
    );
    const reserved = withKey(withName(empty, 'Api', taken), 'API', taken);
    expect(createTeamProblems(reserved, taken).key).toMatch(/^API is reserved/);
  });

  it('asks for a name, a key the name can’t suggest, and a real time zone', () => {
    expect(createTeamProblems(empty, taken)).toEqual({
      name: 'Team name is required, like Engineering',
    });
    expect(createTeamProblems(withName(empty, 'X', taken), taken).key).toBe(
      'Choose a team key: 2–5 capital letters, like ENG.',
    );
    const zone = { ...withName(empty, 'Design', taken), timezone: 'PST' };
    expect(createTeamProblems(zone, taken).timezone).toMatch(/"PST" is not a time zone/);
  });

  it('puts the server’s key refusals on the key field, other errors above the form', () => {
    expect(
      placeServerError({
        code: 'CONFLICT',
        message: 'Team key SEC is taken. Try SECU, or choose another.',
      }),
    ).toEqual({ field: 'key', message: 'Team key SEC is taken. Try SECU, or choose another.' });
    expect(
      placeServerError({
        code: 'INVALID_INPUT',
        message: 'API is reserved; choose another team key.',
      }).field,
    ).toBe('key');
    expect(placeServerError({ code: 'INTERNAL', message: 'Something went wrong' }).field).toBe(
      'form',
    );
  });

  it('places every key problem the server can send on the key field (teamKeyIssue wording)', () => {
    const takenKey = teamKeyIssue('ENG', 'Engineering', (k) => k === 'ENG');
    const malformed = teamKeyIssue('E1', 'Engineering', () => false);
    const reserved = teamKeyIssue('API', 'Api things', () => false);
    for (const [issue, code] of [
      [takenKey, 'CONFLICT'],
      [malformed, 'INVALID_INPUT'],
      [reserved, 'INVALID_INPUT'],
    ] as const) {
      expect(issue).toBeDefined();
      expect(placeServerError({ code, message: issue?.message ?? '' }).field).toBe('key');
    }
  });

  it('remembers a key the server refused as taken, so it isn’t suggested again (D2)', () => {
    const refused = withRefusedKey(new Set(), { code: 'CONFLICT' }, 'SEC');
    expect([...refused]).toEqual(['SEC']);
    expect(withName(empty, 'Security', taken).key).toBe('SEC');
    const known = new Set([...taken, ...refused]);
    expect(withName(empty, 'Security', known).key).toBe('SECU');
    expect(withRefusedKey(refused, { code: 'INTERNAL' }, 'OPS')).toBe(refused);
    expect(withRefusedKey(refused, { code: 'CONFLICT' }, undefined)).toBe(refused);
  });

  it('builds a team.create input the operation accepts', () => {
    const form = { ...withName(empty, 'Design', taken), icon: ' 🎨 ', color: 'pink' as const };
    const input = createTeamInput(form, uuidv7());
    expect(teamCreate.input.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({ name: 'Design', key: 'DES', icon: '🎨', color: 'pink' });
    expect(createTeamInput(withName(empty, 'Design', taken), uuidv7())).not.toHaveProperty('icon');
  });
});

describe('team settings → General', () => {
  const saved = teamSettingsForm({
    name: 'Engineering',
    icon: '🛠',
    color: 'blue',
    timezone: 'UTC',
  });

  it('sends only the edited fields that differ', () => {
    expect(teamSettingsChanges('ENG', saved, {})).toBeUndefined();
    expect(teamSettingsChanges('ENG', saved, { name: 'Engineering ' })).toBeUndefined();
    expect(teamSettingsChanges('ENG', saved, { name: ' Platform ' })).toEqual({
      team: 'ENG',
      name: 'Platform',
    });
    expect(teamSettingsChanges('ENG', saved, { icon: '', color: 'red' })).toEqual({
      team: 'ENG',
      icon: null,
      color: 'red',
    });
  });

  it('keeps another member’s change made while this form is being edited', () => {
    const edits = { name: 'Platform' };
    // Iris changes the color; the delta lands while Ada is still typing.
    const live = { ...saved, color: 'red' as const };
    expect(withEdits(live, edits)).toEqual({ ...live, name: 'Platform' });
    expect(teamSettingsChanges('ENG', live, edits)).toEqual({ team: 'ENG', name: 'Platform' });
  });

  it('checks the name and time zone', () => {
    expect(teamSettingsProblems({ ...saved, name: ' ' }).name).toBe(
      'Team name is required, like Engineering',
    );
    expect(teamSettingsProblems({ ...saved, timezone: 'Mars/Base' }).timezone).toMatch(
      /is not a time zone/,
    );
    expect(teamSettingsProblems(saved)).toEqual({});
  });
});

describe('submitMutation', () => {
  const store = (connection: string, outcome: Promise<never> | Promise<unknown>) => {
    const dispatch = vi.fn(() => outcome);
    // Observable, like the real store's, so a drop while waiting is seen.
    const state = observable({ connection });
    const fake = {
      get connection() {
        return state.connection;
      },
      dispatch,
    } as unknown as MutationStore;
    return {
      store: fake,
      dispatch,
      drop: () => runInAction(() => (state.connection = 'connecting')),
    };
  };

  it('waits for the server online and reports a refusal', async () => {
    const ok = store('online', Promise.resolve({ status: 'confirmed' }));
    expect(await submitMutation(ok.store, teamCreate, { name: 'Design' })).toEqual({
      kind: 'confirmed',
    });
    const refused = store(
      'online',
      Promise.resolve({ status: 'rejected', error: { code: 'CONFLICT', message: 'Taken' } }),
    );
    expect(await submitMutation(refused.store, teamCreate, { name: 'Design' })).toEqual({
      kind: 'rejected',
      code: 'CONFLICT',
      message: 'Taken',
    });
  });

  it('only queues offline, without waiting', async () => {
    const offline = store('offline', new Promise(() => undefined));
    expect(await submitMutation(offline.store, teamCreate, { name: 'Design' })).toEqual({
      kind: 'queued',
    });
    expect(offline.dispatch).toHaveBeenCalledOnce();
  });

  it('stops waiting, as queued, when the connection drops before the answer', async () => {
    const pending = store('online', new Promise(() => undefined));
    const result = submitMutation(pending.store, teamCreate, { name: 'Design' });
    pending.drop();
    expect(await result).toEqual({ kind: 'queued' });
  });

  it('passes a refusal’s issues on, so a form can place it on its field', async () => {
    const issues = [{ path: ['key'], message: 'Team key ENG is taken. Try ENGI.' }];
    const refused = store(
      'online',
      Promise.resolve({
        status: 'rejected',
        error: { code: 'CONFLICT', message: 'Taken', issues },
      }),
    );
    expect(await submitMutation(refused.store, teamCreate, { name: 'Design' })).toEqual({
      kind: 'rejected',
      code: 'CONFLICT',
      message: 'Taken',
      issues,
    });
  });

  /** The `reportRejection` the store was given, asked as the store would at a rejection. */
  const reports = (dispatch: ReturnType<typeof store>['dispatch']) => () => {
    const calls = dispatch.mock.calls as unknown as [unknown, unknown, unknown][];
    const options = calls[0]?.[2] as { reportRejection?: () => boolean } | undefined;
    return options?.reportRejection?.() ?? true;
  };

  it('keeps the shell’s toast quiet while a form that shows the refusal waits for it', async () => {
    let answer: (outcome: unknown) => void = () => undefined;
    const waiting = store(
      'online',
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    let open = true;
    const result = submitMutation(
      waiting.store,
      teamCreate,
      { name: 'Design' },
      { showsRejection: () => open },
    );
    const reported = reports(waiting.dispatch);
    expect(reported()).toBe(false);
    open = false; // closed while waiting: nobody else would show it
    expect(reported()).toBe(true);
    open = true;
    answer({ status: 'rejected', error: { code: 'CONFLICT', message: 'Taken' } });
    expect(await result).toMatchObject({ kind: 'rejected' });
  });

  it('lets the shell report a refusal that comes after the form stopped waiting', async () => {
    const pending = store('online', new Promise(() => undefined));
    const result = submitMutation(
      pending.store,
      teamCreate,
      { name: 'Design' },
      { showsRejection: () => true },
    );
    pending.drop();
    expect(await result).toEqual({ kind: 'queued' });
    expect(reports(pending.dispatch)()).toBe(true);

    const offline = store('offline', new Promise(() => undefined));
    await submitMutation(
      offline.store,
      teamCreate,
      { name: 'Design' },
      { showsRejection: () => true },
    );
    expect(reports(offline.dispatch)()).toBe(true);
  });

  it('lets the shell report every refusal for a caller with no form to show it in', async () => {
    const refused = store(
      'online',
      Promise.resolve({ status: 'rejected', error: { code: 'CONFLICT', message: 'Taken' } }),
    );
    const result = submitMutation(refused.store, teamCreate, { name: 'Design' });
    expect(reports(refused.dispatch)()).toBe(true);
    await result;
  });

  it('reports a change the store refused to queue', async () => {
    const broken = {
      connection: 'online',
      dispatch: () => {
        throw new Error(
          'Changes cannot be saved yet. Wait for the workspace to load, then try again.',
        );
      },
    } as unknown as MutationStore;
    const result = await submitMutation(broken, teamCreate, { name: 'Design' });
    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' ? result.message : '').toMatch(/^Changes cannot be saved yet/);
  });
});
