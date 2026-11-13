// PLAN-012 S5 (SPEC-012 §3.1, §3.2, §3.5): the composer's pure rules. AC-1 (prefill order,
// payload), AC-2 (team change drops and the note), restore (§3.2, E7), and the first version of
// the picker options the pills use.
import { describe, expect, it } from 'vitest';
import {
  changeTeam,
  createPayload,
  createProblem,
  draftData,
  droppedNote,
  freshState,
  hasContent,
  prefillTeam,
  restoreDraft,
  sameContent,
  stateFromCreateInput,
  type ComposerLabel,
  type ComposerStatus,
  type ComposerTeam,
  type ComposerWorld,
} from '../src/features/issues/composer-model.js';
import {
  assigneeOptions,
  estimateOptions,
  labelOptions,
  NONE,
  priorityOptions,
  statusOptions,
} from '../src/features/issues/picker-options.js';

const ME = 'u-me';
const ADA = 'u-ada';
const BOB = 'u-bob';
const GONE = 'u-gone';

const team = (id: string, key: string, extra: Partial<ComposerTeam> = {}): ComposerTeam => ({
  id,
  key,
  name: key === 'ENG' ? 'Engineering' : key === 'DES' ? 'Design' : 'Security',
  private: false,
  defaultStatusId: `${id}-backlog`,
  estimate: { scale: 'linear', extended: false, allowZero: false },
  ...extra,
});

const status = (
  teamId: string,
  name: string,
  category: ComposerStatus['category'],
  position = 'a0',
): ComposerStatus => ({
  id: `${teamId}-${name.toLowerCase().replace(/ /g, '-')}`,
  teamId,
  name,
  category,
  position,
  color: 'gray',
});

const label = (id: string, name: string, extra: Partial<ComposerLabel> = {}): ComposerLabel => ({
  id,
  name,
  teamId: null,
  archived: false,
  isGroup: false,
  parentId: null,
  exclusive: false,
  color: 'blue',
  ...extra,
});

const ENG = team('eng', 'ENG');
const DES = team('des', 'DES', { estimate: { scale: 'off', extended: false, allowZero: false } });
const SEC = team('sec', 'SEC', {
  private: true,
  estimate: { scale: 'tshirt', extended: false, allowZero: false },
});

function world(extra: Partial<ComposerWorld> = {}): ComposerWorld {
  return {
    me: ME,
    teams: [ENG, DES, SEC],
    memberTeamIds: ['eng', 'des', 'sec'],
    members: { eng: [ME, ADA, BOB], des: [ME], sec: [ME, BOB] },
    statuses: [
      status('eng', 'Triage', 'triage'),
      status('eng', 'Backlog', 'backlog'),
      status('eng', 'Todo', 'unstarted'),
      status('eng', 'In Progress', 'started'),
      status('eng', 'Done', 'completed'),
      status('eng', 'Duplicate', 'duplicate'),
      status('des', 'Todo', 'unstarted'),
      status('sec', 'Backlog', 'backlog'),
    ],
    labels: [
      label('l-frontend', 'Frontend', { teamId: 'eng' }),
      label('l-bug', 'Bug'),
      label('l-old', 'Old', { archived: true }),
      label('g-size', 'Size', { isGroup: true, exclusive: true }),
      label('l-small', 'Small', { parentId: 'g-size' }),
      label('l-large', 'Large', { parentId: 'g-size' }),
    ],
    users: [
      { id: ME, name: 'Me Myself', displayName: 'me', email: 'me@example.com', active: true },
      { id: ADA, name: 'Ada', displayName: 'ada', email: 'ada@example.com', active: true },
      { id: BOB, name: 'Bob', displayName: 'bob', email: 'bob@example.com', active: true },
      { id: GONE, name: 'Gone', displayName: 'gone', email: 'gone@example.com', active: false },
    ],
    homeTeamId: null,
    ...extra,
  };
}

describe('prefillTeam (§3.1 item 2, AC-1)', () => {
  it('takes the route’s team first, in any case', () => {
    expect(prefillTeam(world({ homeTeamId: 'des' }), 'sec')?.key).toBe('SEC');
  });

  it('then the home team, then the first team the user is in, then the first visible team', () => {
    expect(prefillTeam(world({ homeTeamId: 'des' }), undefined)?.key).toBe('DES');
    expect(prefillTeam(world({ memberTeamIds: ['sec', 'eng'] }), undefined)?.key).toBe('SEC');
    expect(prefillTeam(world({ memberTeamIds: [] }), undefined)?.key).toBe('DES');
  });

  it('skips a route or home team the user can’t see, and gives nothing with no team (item 3)', () => {
    expect(prefillTeam(world({ homeTeamId: 'hidden' }), 'NOPE')?.key).toBe('ENG');
    expect(prefillTeam(world({ teams: [], memberTeamIds: [] }), 'ENG')).toBeUndefined();
  });
});

describe('freshState: a group’s + (§3.1 item 2)', () => {
  const add = { teamId: 'eng', statusId: 'eng-todo', statusName: 'Todo', assignToMe: false };

  it('sets the group’s status on a team list', () => {
    expect(freshState(world(), 'eng', add).statusId).toBe('eng-todo');
  });

  it('on My issues, takes the team’s status of the same name, and assigns me on Assigned', () => {
    const state = freshState(world(), 'des', { ...add, teamId: null, assignToMe: true });
    expect(state.statusId).toBe('des-todo');
    expect(state.assigneeId).toBe(ME);
  });

  it('leaves the team default when the team has no such status, or it is Triage', () => {
    expect(freshState(world(), 'sec', { ...add, teamId: null }).statusId).toBeNull();
    const triage = { ...add, statusId: 'eng-triage', statusName: 'Triage' };
    expect(freshState(world(), 'eng', triage).statusId).toBeNull();
  });

  it('a plain C starts empty', () => {
    expect(freshState(world(), 'eng')).toMatchObject({
      teamId: 'eng',
      title: '',
      statusId: null,
      priority: 0,
      assigneeId: null,
      labelIds: [],
      estimate: null,
      dueDate: null,
    });
  });
});

describe('changeTeam (§3.1 item 4, AC-2)', () => {
  const full = {
    ...freshState(world(), 'eng'),
    title: 'Keep me',
    statusId: 'eng-todo',
    priority: 2,
    assigneeId: ADA,
    labelIds: ['l-frontend', 'l-bug'],
    estimate: 3,
    dueDate: '2026-12-01',
  };

  it('drops status, team labels, an estimate the scale doesn’t allow, and keeps the rest', () => {
    const { state, dropped } = changeTeam(world(), full, 'des');
    expect(state).toMatchObject({
      teamId: 'des',
      title: 'Keep me',
      statusId: null,
      priority: 2,
      assigneeId: ADA,
      labelIds: ['l-bug'],
      estimate: null,
      dueDate: '2026-12-01',
    });
    expect(droppedNote(dropped)).toBe('Dropped: status Todo, label Frontend, estimate 3.');
  });

  it('drops an assignee who isn’t a member of a private target team', () => {
    const { state, dropped } = changeTeam(world(), { ...full, estimate: null }, 'sec');
    expect(state.assigneeId).toBeNull();
    expect(dropped).toContain('assignee Ada');
    expect(changeTeam(world(), { ...full, assigneeId: BOB }, 'sec').state.assigneeId).toBe(BOB);
  });

  it('names the estimate as the old team showed it (t-shirt sizes)', () => {
    const fromSec = { ...full, teamId: 'sec', statusId: null, labelIds: [], estimate: 5 };
    expect(changeTeam(world(), fromSec, 'des').dropped).toEqual(['estimate L']);
  });

  it('drops nothing when every value still fits, and the note is then absent', () => {
    const plain = { ...full, statusId: null, labelIds: ['l-bug'], estimate: null };
    const { dropped } = changeTeam(world(), plain, 'des');
    expect(dropped).toEqual([]);
    expect(droppedNote(dropped)).toBeUndefined();
  });
});

describe('restoreDraft (§3.2)', () => {
  // Stored data is validated as the operation would (ids are UUIDs), so this world uses them.
  const u = (n: number) => `0192f0c1-7e5a-7b3c-9d4e-${String(n).padStart(12, '0')}`;
  const [BUG, OLD, DELETED, STATUS, LEFT] = [u(1), u(2), u(3), u(4), u(5)];
  const stored = world({
    labels: [label(BUG, 'Bug'), label(OLD, 'Old', { archived: true })],
    users: [{ id: LEFT, name: 'Gone', displayName: 'gone', email: 'g@example.com', active: false }],
  });

  it('reads the stored fields and drops what no longer resolves, with the note', () => {
    const restored = restoreDraft(
      stored,
      {
        title: 'Saved',
        description: null,
        statusId: STATUS,
        priority: 1,
        assigneeId: LEFT,
        labelIds: [OLD, DELETED, BUG],
        estimate: 2,
        dueDate: null,
      },
      'eng',
    );
    expect(restored?.state).toMatchObject({
      title: 'Saved',
      statusId: null,
      priority: 1,
      assigneeId: null,
      labelIds: [BUG],
      estimate: 2,
    });
    expect(droppedNote(restored?.dropped ?? [])).toBe(
      'Dropped: a deleted status, label Old, a deleted label, assignee Gone.',
    );
  });

  it('E7: a draft of a team the user can no longer see opens in the given team, and says so', () => {
    const restored = restoreDraft(world(), { title: 'Secret plan' }, 'eng', true);
    expect(restored?.state.teamId).toBe('eng');
    expect(restored?.state.title).toBe('Secret plan');
    expect(restored?.dropped[0]).toBe('its team, which you can no longer see');
  });

  it('a broken field falls back on its own; nothing for a team the user can’t see', () => {
    expect(restoreDraft(world(), { title: 'T', priority: 'urgent' }, 'eng')?.state.priority).toBe(
      0,
    );
    expect(restoreDraft(world(), {}, 'hidden')).toBeUndefined();
  });
});

describe('the payload and the draft (§3.1 item 6, §4.3)', () => {
  const state = {
    ...freshState(world(), 'eng'),
    title: 'Fix it',
    statusId: 'eng-todo',
    priority: 1,
    assigneeId: ADA,
    labelIds: ['l-bug'],
    estimate: 3,
    dueDate: '2026-12-01',
  };

  it('issue.create takes ids for every reference and no description until PLAN-011 S6', () => {
    expect(createPayload(state, 'new-id')).toEqual({
      id: 'new-id',
      team: 'eng',
      title: 'Fix it',
      status: 'eng-todo',
      priority: 1,
      assignee: ADA,
      labels: ['l-bug'],
      estimate: 3,
      dueDate: '2026-12-01',
    });
  });

  it('leaves out empty properties, so the server applies the team’s defaults', () => {
    expect(createPayload(freshState(world(), 'eng'), 'x')).toEqual({
      id: 'x',
      team: 'eng',
      title: '',
    });
  });

  it('the draft keeps every field, and a rejected input comes back as the same state', () => {
    expect(draftData(state)).toEqual({
      title: 'Fix it',
      description: null,
      statusId: 'eng-todo',
      priority: 1,
      assigneeId: ADA,
      labelIds: ['l-bug'],
      estimate: 3,
      dueDate: '2026-12-01',
    });
    const back = stateFromCreateInput(world(), createPayload(state, 'id'));
    expect(back?.dropped).toEqual([]);
    expect(back !== undefined && sameContent(back.state, state)).toBe(true);
    expect(stateFromCreateInput(world(), { team: 'hidden', title: 'x' })).toBeUndefined();
    expect(stateFromCreateInput(world(), 'nonsense')).toBeUndefined();
  });

  it('a title is required; content is a title or a description', () => {
    expect(createProblem({ ...state, title: '   ' })).toBeDefined();
    expect(createProblem(state)).toBeUndefined();
    expect(hasContent({ title: '  ', description: null })).toBe(false);
    expect(hasContent({ title: 'x', description: null })).toBe(true);
  });
});

describe('picker options (§3.5, first version)', () => {
  it('status: the team’s statuses in workflow order, no Triage or Duplicate, 1–9 by position', () => {
    const options = statusOptions(world().statuses, 'eng');
    expect(options.map((o) => o.label)).toEqual(['Backlog', 'Todo', 'In Progress', 'Done']);
    expect(options.map((o) => o.quickKey)).toEqual(['1', '2', '3', '4']);
  });

  it('priority: No priority to Low with 0–4', () => {
    expect(priorityOptions().map((o) => `${o.quickKey ?? ''} ${o.label}`)).toEqual([
      '0 No priority',
      '1 Urgent',
      '2 High',
      '3 Medium',
      '4 Low',
    ]);
  });

  it('assignee: No assignee, Me, members, then others on a public team; members only on a private one', () => {
    const w = world();
    expect(assigneeOptions(w.users, DES, w.members['des'] ?? [], ME).map((o) => o.label)).toEqual([
      'No assignee',
      'Me',
      'Ada',
      'Bob',
    ]);
    expect(assigneeOptions(w.users, SEC, w.members['sec'] ?? [], ME).map((o) => o.label)).toEqual([
      'No assignee',
      'Me',
      'Bob',
    ]);
    expect(assigneeOptions(w.users, DES, [], ME)[0]?.id).toBe(NONE);
  });

  it('labels: team then workspace, archived only when applied, an exclusive group’s labels exclusive', () => {
    const options = labelOptions(world().labels, 'eng', []);
    expect(options.map((o) => o.label)).toEqual(['Frontend', 'Bug', 'Large', 'Small']);
    expect(options.find((o) => o.label === 'Small')).toMatchObject({
      group: 'Size',
      exclusiveGroup: 'g-size',
    });
    expect(labelOptions(world().labels, 'eng', ['l-old']).map((o) => o.label)).toContain('Old');
    expect(labelOptions(world().labels, 'des', []).map((o) => o.label)).not.toContain('Frontend');
  });

  it('estimate: No estimate on 0, values with their labels, a digit equal to a value picks it', () => {
    const tshirt = estimateOptions(SEC.estimate);
    expect(tshirt.map((o) => `${o.quickKey ?? '-'} ${o.label}`)).toEqual([
      '0 No estimate',
      '1 XS',
      '2 S',
      '3 M',
      '5 L',
      '8 XL',
    ]);
    expect(estimateOptions(DES.estimate)).toEqual([]);
  });
});
