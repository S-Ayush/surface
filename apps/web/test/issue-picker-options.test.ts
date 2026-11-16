// PLAN-012 S6 (SPEC-012 §3.5, AC-7, AC-24, E17, E21): what a bound picker offers for an issue and
// the one `issue.update` each choice sends. The anchored pickers, the pills, the keys and the
// command menu all ask `issue-pickers.ts`, so this is the single place the rules are checked.
// (Quick keys and the `Space`/`Enter` rules of the labels picker are `ui/test/property-picker`.)
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ComposerWorld } from '../src/features/issues/composer-model.js';
import {
  assignToMeInput,
  dueDateInput,
  labelsInput,
  lifecycleReason,
  pickerSpec,
  singleInput,
  type IssueFacts,
} from '../src/features/issues/issue-pickers.js';
import { estimatesOffMessage, labelChange, NONE } from '../src/features/issues/picker-options.js';

const ME = 'u-me';
const BOB = 'u-bob';
const ZED = 'u-zed';

const team = (id: string, key: string, scale: string, isPrivate = false) => ({
  id,
  key,
  name: key,
  private: isPrivate,
  defaultStatusId: `${id}-todo`,
  estimate: { scale, extended: false, allowZero: false },
});

const status = (teamId: string, name: string, category: string, position: string) => ({
  id: `${teamId}-${name.toLowerCase()}`,
  teamId,
  name,
  category,
  position,
  color: 'gray',
});

const world = {
  me: ME,
  homeTeamId: null,
  memberTeamIds: ['eng', 'sec'],
  teams: [team('eng', 'ENG', 'linear'), team('sec', 'SEC', 'off', true)],
  members: { eng: [ME, BOB], sec: [ME, BOB] },
  statuses: [
    status('eng', 'Triage', 'triage', 'a0'),
    status('eng', 'Todo', 'unstarted', 'a1'),
    status('eng', 'Done', 'completed', 'a2'),
    status('eng', 'Duplicate', 'duplicate', 'a3'),
    status('sec', 'Todo', 'unstarted', 'a1'),
  ],
  labels: [
    {
      id: 'l-bug',
      name: 'Bug',
      teamId: null,
      archived: false,
      isGroup: false,
      parentId: null,
      exclusive: false,
      color: 'red',
    },
    {
      id: 'l-old',
      name: 'Old',
      teamId: null,
      archived: true,
      isGroup: false,
      parentId: null,
      exclusive: false,
      color: 'gray',
    },
    {
      id: 'g-size',
      name: 'Size',
      teamId: null,
      archived: false,
      isGroup: true,
      parentId: null,
      exclusive: true,
      color: 'blue',
    },
    {
      id: 'l-s',
      name: 'Small',
      teamId: null,
      archived: false,
      isGroup: false,
      parentId: 'g-size',
      exclusive: false,
      color: 'blue',
    },
    {
      id: 'l-l',
      name: 'Large',
      teamId: null,
      archived: false,
      isGroup: false,
      parentId: 'g-size',
      exclusive: false,
      color: 'blue',
    },
  ],
  users: [
    { id: ME, name: 'Me', displayName: 'me', email: 'me@x.test', active: true },
    { id: BOB, name: 'Bob', displayName: 'bob', email: 'bob@x.test', active: true },
    { id: ZED, name: 'Zed', displayName: 'zed', email: 'zed@x.test', active: true },
  ],
} as unknown as ComposerWorld;

const facts = (extra: Partial<IssueFacts> = {}): IssueFacts => ({
  id: 'issue-1',
  teamId: 'eng',
  number: 42,
  title: 'Fix login',
  statusId: 'eng-todo',
  priority: 2,
  assigneeId: null,
  labelIds: [],
  estimate: null,
  dueDate: null,
  lifecycle: 'live',
  ...extra,
});

const labels = (of: IssueFacts) => {
  const spec = pickerSpec('labels', world, of);
  return spec?.mode === 'multi' ? spec : undefined;
};

describe('the options each picker offers (AC-7)', () => {
  it('status: the team’s workflow with the current one checked, Triage and Duplicate left out', () => {
    const spec = pickerSpec('status', world, facts());
    expect(spec).toMatchObject({ mode: 'single', value: 'eng-todo' });
    expect(spec?.mode === 'single' && spec.options.map((o) => o.label)).toEqual(['Todo', 'Done']);
  });

  it('priority: the current value is checked, as text of its number', () => {
    expect(pickerSpec('priority', world, facts({ priority: 3 }))).toMatchObject({ value: '3' });
  });

  it('assignee: a private team offers only its members; "No assignee" is checked when nobody is', () => {
    const eng = pickerSpec('assignee', world, facts());
    const sec = pickerSpec('assignee', world, facts({ teamId: 'sec' }));
    expect(eng?.mode === 'single' && eng.options.map((o) => o.label)).toEqual([
      'No assignee',
      'Me',
      'Bob',
      'Zed',
    ]);
    expect(sec?.mode === 'single' && sec.options.map((o) => o.label)).toEqual([
      'No assignee',
      'Me',
      'Bob',
    ]);
    expect(eng).toMatchObject({ value: NONE });
  });

  it('labels: archived ones only when applied; a group’s labels are exclusive (INV-07)', () => {
    expect(labels(facts())?.options.map((o) => o.label)).toEqual(['Bug', 'Large', 'Small']);
    expect(labels(facts({ labelIds: ['l-old'] }))?.options.map((o) => o.label)).toContain('Old');
    expect(labels(facts())?.options.find((o) => o.id === 'l-s')?.exclusiveGroup).toBe('g-size');
  });

  it('estimate: the scale’s values; nothing on a team whose scale is off (Shift+E shows the hint)', () => {
    const linear = pickerSpec('estimate', world, facts({ estimate: 3 }));
    expect(linear).toMatchObject({ value: '3' });
    expect(pickerSpec('estimate', world, facts({ teamId: 'sec' }))).toBeUndefined();
    expect(estimatesOffMessage('SEC')).toBe(
      "SEC doesn't use estimates. Turn them on in team settings.",
    );
  });

  it('a team the replica no longer holds offers nothing', () => {
    expect(pickerSpec('status', world, facts({ teamId: 'gone' }))).toBeUndefined();
  });
});

describe('the one issue.update a choice sends (AC-7)', () => {
  it('sends only the changed field', () => {
    expect(singleInput('status', facts(), 'eng-done')).toEqual({
      issue: 'issue-1',
      status: 'eng-done',
    });
    expect(singleInput('priority', facts(), '1')).toEqual({ issue: 'issue-1', priority: 1 });
    expect(singleInput('assignee', facts(), BOB)).toEqual({ issue: 'issue-1', assignee: BOB });
    expect(singleInput('estimate', facts(), '5')).toEqual({ issue: 'issue-1', estimate: 5 });
    expect(dueDateInput(facts(), '2026-12-03')).toEqual({
      issue: 'issue-1',
      dueDate: '2026-12-03',
    });
  });

  it('"No assignee", "No estimate" and "No due date" send null', () => {
    expect(singleInput('assignee', facts({ assigneeId: BOB }), NONE)).toEqual({
      issue: 'issue-1',
      assignee: null,
    });
    expect(singleInput('estimate', facts({ estimate: 3 }), NONE)).toEqual({
      issue: 'issue-1',
      estimate: null,
    });
    expect(dueDateInput(facts({ dueDate: '2026-12-03' }), null)).toEqual({
      issue: 'issue-1',
      dueDate: null,
    });
  });

  it('choosing the current value sends nothing', () => {
    expect(singleInput('status', facts(), 'eng-todo')).toBeUndefined();
    expect(singleInput('priority', facts(), '2')).toBeUndefined();
    expect(singleInput('assignee', facts(), NONE)).toBeUndefined();
    expect(singleInput('estimate', facts(), NONE)).toBeUndefined();
    expect(dueDateInput(facts(), null)).toBeUndefined();
  });

  it('labels: one update with the difference, and nothing when unchanged', () => {
    const before = facts({ labelIds: ['l-bug', 'l-s'] });
    // Choosing Large in the exclusive Size group unchecks Small (the picker's own rule).
    expect(labelsInput(before, before.labelIds, ['l-bug', 'l-l'])).toEqual({
      issue: 'issue-1',
      addLabels: ['l-l'],
      removeLabels: ['l-s'],
    });
    expect(labelsInput(before, before.labelIds, ['l-s', 'l-bug'])).toBeUndefined();
  });

  it('labels: a label someone else added while the picker was open survives (review m1)', () => {
    // The picker opened with Bug; meanwhile another client added Small; the user then adds Large.
    const now = facts({ labelIds: ['l-bug', 'l-s'] });
    expect(labelsInput(now, ['l-bug'], ['l-bug', 'l-l'])).toEqual({
      issue: 'issue-1',
      addLabels: ['l-l'],
    });
    // Unchecking both removes only what is still there: Old was removed by someone else meanwhile.
    expect(labelsInput(now, ['l-bug', 'l-old'], [])).toEqual({
      issue: 'issue-1',
      removeLabels: ['l-bug'],
    });
    // Nothing the user toggled changes the issue now: nothing is sent.
    expect(labelsInput(facts({ labelIds: ['l-bug'] }), [], ['l-bug'])).toBeUndefined();
  });

  it('assign to me does nothing when it is already mine or the team doesn’t offer "Me" (§3.6)', () => {
    expect(assignToMeInput(world, facts())).toEqual({ issue: 'issue-1', assignee: ME });
    expect(assignToMeInput(world, facts({ assigneeId: ME }))).toBeUndefined();
    const outsider = { ...world, members: { ...world.members, sec: [BOB] } };
    expect(assignToMeInput(outsider, facts({ teamId: 'sec' }))).toBeUndefined();
  });
});

describe('labelChange', () => {
  const ids = fc.uniqueArray(fc.constantFrom<string>('a', 'b', 'c', 'd', 'e'));

  it('property: applying the difference to the labels before gives the labels after', () => {
    fc.assert(
      fc.property(ids, ids, (before, after) => {
        const change = labelChange(before, after);
        const applied = new Set(before);
        for (const id of change?.removeLabels ?? []) applied.delete(id);
        for (const id of change?.addLabels ?? []) applied.add(id);
        expect([...applied].sort()).toEqual([...after].sort());
        // Never both adds and removes the same label, and nothing at all when nothing changed.
        const added = change?.addLabels ?? [];
        expect(added.some((id) => change?.removeLabels?.includes(id))).toBe(false);
        expect(change === undefined).toBe([...before].sort().join() === [...after].sort().join());
      }),
    );
  });
});

describe('the reason a locked issue gives (§3.8)', () => {
  it('names the state and says how to fix it', () => {
    expect(lifecycleReason('ENG-42', 'archived')).toBe(
      'ENG-42 is archived. Restore it to edit it.',
    );
    expect(lifecycleReason('ENG-42', 'deleted')).toBe('ENG-42 was deleted. Restore it to edit it.');
    expect(lifecycleReason('ENG-42', 'live')).toBeUndefined();
  });
});
