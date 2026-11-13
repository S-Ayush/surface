/**
 * @vitest-environment jsdom
 */
// PLAN-012 S5 (SPEC-012 §3.1, §3.2): the composer as the shell mounts it, over a fake store that
// records what is dispatched. AC-1 (prefill, create, "Create more", no team), AC-3 (the "Save as
// draft?" prompt, restore, discard), E6 (`C` while open), E8 (a team without estimates), E20 (the
// replace prompt), E25 (Discard leaves the saved draft alone), AC-18 (creation announced).
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { runInAction } from 'mobx';
import { inAct, keydown, setValue } from './issue-fixtures.js';
import {
  buttonNamed,
  ComposerApp,
  DES,
  dialogNamed,
  draftRow,
  ENG,
  ENG_TODO,
  LABEL_BUG,
  LABEL_FRONTEND,
  SEC,
  mountComposer,
  titleInput,
  type Mounted,
} from './composer-harness.js';
import {
  NO_TEAM_MESSAGE,
  REPLACE_QUESTION,
  replaceDraftQuestion,
} from '../src/features/issues/IssuesHost.js';
import { announcer } from '../src/features/issues/announcer.js';
import { openComposerWith } from '../src/features/issues/composer-request.js';
import { overlayManager } from '@surface/ui';

let mounted: Mounted | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  localStorage.clear();
  overlayManager.clear();
  document.body.innerHTML = '';
});

async function open(app: ComposerApp, path = '/team/ENG/issues'): Promise<Mounted> {
  mounted = await mountComposer(app, path);
  const m = mounted;
  await inAct(() => {
    m.commands().run('issue:create');
  });
  return m;
}

const composer = () => dialogNamed('New issue');
const pill = (name: string) =>
  [...(composer()?.querySelectorAll('button') ?? [])].find((b) =>
    b.textContent?.startsWith(`${name}:`),
  );

async function click(element: Element): Promise<void> {
  await inAct(() => {
    (element as HTMLElement).click();
  });
}

/** Picks another team in the header's team picker. */
async function chooseTeam(name: string): Promise<void> {
  const team = pill('Team');
  if (team === undefined) throw new Error('no team pill');
  await click(team);
  const option = [...document.querySelectorAll('[role="option"]')].find((o) =>
    o.textContent?.includes(name),
  );
  if (option === undefined) throw new Error(`no ${name} option`);
  await click(option);
}

/** Lets the dispatcher's settled promises reach the host. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe('opening (AC-1)', () => {
  it('opens for the route’s team with focus in the title', async () => {
    const app = new ComposerApp();
    await open(app, '/team/DES/issues');
    expect(composer()).toBeDefined();
    expect(pill('Team')?.textContent).toContain('DES');
    expect(document.activeElement).toBe(titleInput());
  });

  it('with no visible team, opens nothing and the toast says how to make one', async () => {
    const app = new ComposerApp({ teams: 'none' });
    await open(app, '/drafts');
    expect(composer()).toBeUndefined();
    expect(document.body.textContent).toContain(NO_TEAM_MESSAGE);
    expect(buttonNamed('Open settings')).toBeDefined();
  });

  it('E6: running it again while open does nothing', async () => {
    const app = new ComposerApp();
    const m = await open(app);
    await setValue(titleInput(), 'Half typed');
    let ran = true;
    await inAct(() => {
      ran = m.commands().run('issue:create');
    });
    expect(ran).toBe(false);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(titleInput().value).toBe('Half typed');
  });
});

describe('creating (AC-1, §3.1 items 6 to 9)', () => {
  it('an empty title: Create is aria-disabled, and submitting says "Title is required." with no dispatch', async () => {
    const app = new ComposerApp();
    await open(app);
    const create = buttonNamed('Create issue');
    expect(create.getAttribute('aria-disabled')).toBe('true');
    expect(create.disabled).toBe(false);
    expect(
      document.getElementById(create.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Add a title to create the issue');
    await click(create);
    expect(composer()?.textContent).toContain('Title is required.');
    expect(app.ops()).toEqual([]);
    expect(document.activeElement).toBe(titleInput());
  });

  it('creates with the chosen properties, closes, clears the team’s draft and toasts "Created ENG-…"', async () => {
    const app = new ComposerApp({ drafts: [draftRow({ teamId: ENG, data: { title: 'Old' } })] });
    await open(app);
    await setValue(titleInput(), 'Fix the login loop');
    await click(buttonNamed('Create issue'));
    expect(app.ops()).toEqual(['issue.create', 'draft.discard']);
    const [create, discard] = app.dispatched;
    expect(create?.input).toMatchObject({ team: ENG, title: 'Fix the login loop' });
    expect(create?.input).not.toHaveProperty('description');
    expect(typeof create?.input['id']).toBe('string');
    expect(discard?.input).toEqual({ kind: 'composer', teamId: ENG });
    expect(composer()).toBeUndefined();
    expect(document.body.textContent).toContain('Created ENG-…');
  });

  it('"Create more" keeps the properties, clears the title and stays open; it is remembered', async () => {
    const app = new ComposerApp({
      drafts: [
        draftRow({ teamId: ENG, data: { title: 'First', statusId: ENG_TODO, priority: 2 } }),
      ],
    });
    await open(app);
    await click(document.querySelector('button[role="switch"]') ?? document.body);
    expect(localStorage.getItem('surface.composer.createMore')).toBe('true');
    await click(buttonNamed('Create issue'));
    expect(app.dispatched[0]?.input).toMatchObject({
      title: 'First',
      status: ENG_TODO,
      priority: 2,
    });
    expect(composer()).toBeDefined();
    expect(titleInput().value).toBe('');
    expect(pill('Status')?.textContent).toContain('Todo');
    expect(pill('Priority')?.textContent).toContain('High');
    expect(document.activeElement).toBe(titleInput());
  });

  it('the toast and the live region say the number once it arrives (AC-18)', async () => {
    const app = new ComposerApp();
    const m = await open(app);
    await setValue(titleInput(), 'Numbered');
    await click(buttonNamed('Create issue'));
    expect(document.body.textContent).toContain('Created ENG-…');
    const issueId = String(app.dispatched[0]?.input['id']);
    // The server's row reaches the replica with its number: the toast updates in place.
    await inAct(() => {
      runInAction(() => {
        app.issueRows.set([{ id: issueId, teamId: ENG, number: 42, title: 'Numbered' }]);
      });
    });
    expect(document.body.textContent).toContain('Created ENG-42');
    expect(document.body.textContent).not.toContain('Created ENG-…');
    expect(announcer.snapshot().text).toBe('Created ENG-42');
    await click(buttonNamed('Open'));
    expect(m.path()).toBe('/issue/ENG-42/numbered');
  });
});

describe('a rejected create (§3.1 item 9, E20, AC-24)', () => {
  it('toasts the reason with Restore in composer, which reopens with what was sent', async () => {
    const app = new ComposerApp();
    await open(app);
    await setValue(titleInput(), 'Rejected one');
    await click(buttonNamed('Create issue'));
    app.dispatched[0]?.settle({
      status: 'rejected',
      error: { code: 'INVALID_INPUT', message: 'That status was deleted.' },
    });
    await flush();
    expect(document.body.textContent).toContain(
      "Couldn't create the issue: That status was deleted.",
    );
    expect(announcer.snapshot().text).toContain('That status was deleted.');
    await click(buttonNamed('Restore in composer'));
    expect(composer()).toBeDefined();
    expect(titleInput().value).toBe('Rejected one');
  });

  it('E20: with the next issue typed in the composer, it asks first; Cancel keeps the composer', async () => {
    const app = new ComposerApp();
    const m = await open(app);
    await setValue(titleInput(), 'First issue');
    await click(buttonNamed('Create issue'));
    // The "Created" toast shows once the composer has closed; it stays when `C` opens it again
    // (a toast never shows for the first time over a modal, design-system §5.1).
    expect(document.body.textContent).toContain('Created ENG-…');
    await inAct(() => {
      m.commands().run('issue:create');
    });
    await setValue(titleInput(), 'Second issue');
    app.dispatched[0]?.settle({
      status: 'rejected',
      error: { code: 'INVALID_INPUT', message: 'No.' },
    });
    await flush();
    await click(buttonNamed('Restore in composer'));
    const prompt = dialogNamed(REPLACE_QUESTION);
    expect(prompt).toBeDefined();
    await click(buttonNamed('Cancel', prompt));
    expect(dialogNamed(REPLACE_QUESTION)).toBeUndefined();
    expect(titleInput().value).toBe('Second issue');
    // The toast comes back (shown once the composer closes), so its text stays copyable and
    // Restore can be tried again; with the composer closed it opens without asking.
    await keydown(titleInput(), 'Escape');
    await click(buttonNamed('Discard', dialogNamed('Save as draft?')));
    await click(buttonNamed('Restore in composer'));
    expect(dialogNamed(REPLACE_QUESTION)).toBeUndefined();
    expect(titleInput().value).toBe('First issue');
  });

  it('E20: Replace swaps the composer’s content for the rejected issue', async () => {
    const app = new ComposerApp();
    const m = await open(app);
    await setValue(titleInput(), 'First issue');
    await click(buttonNamed('Create issue'));
    await inAct(() => {
      m.commands().run('issue:create');
    });
    await setValue(titleInput(), 'Second issue');
    app.dispatched[0]?.settle({ status: 'rejected', error: { code: 'X', message: 'No.' } });
    await flush();
    await click(buttonNamed('Restore in composer'));
    await click(buttonNamed('Replace', dialogNamed(REPLACE_QUESTION)));
    expect(dialogNamed(REPLACE_QUESTION)).toBeUndefined();
    expect(titleInput().value).toBe('First issue');
  });
});

describe('requests (the issue page’s Restore in composer, a group’s +)', () => {
  it('E9: a rejected input from the issue page opens the composer with it', async () => {
    const app = new ComposerApp();
    mounted = await mountComposer(app, '/team/ENG/issues');
    const m = mounted;
    let ran = false;
    await inAct(() => {
      ran = openComposerWith(
        { kind: 'rejected', input: { id: 'x', team: DES, title: 'Lost one', priority: 3 } },
        (command) => m.commands().run(command),
      );
    });
    expect(ran).toBe(true);
    expect(titleInput().value).toBe('Lost one');
    expect(pill('Team')?.textContent).toContain('DES');
    expect(pill('Priority')?.textContent).toContain('Medium');
  });

  it('a group’s + opens with the group’s status; a request the composer didn’t take is dropped', async () => {
    const app = new ComposerApp();
    const m = await open(app);
    const add = { teamId: ENG, statusId: ENG_TODO, statusName: 'Todo', assignToMe: true };
    // Open already (E6): not taken, and not left behind for the next `C`.
    expect(openComposerWith({ kind: 'group', add }, (c) => m.commands().run(c))).toBe(false);
    await keydown(titleInput(), 'Escape');
    await inAct(() => {
      m.commands().run('issue:create');
    });
    expect(pill('Status')?.textContent).toContain('Backlog');
    await keydown(titleInput(), 'Escape');
    await inAct(() => {
      openComposerWith({ kind: 'group', add }, (c) => m.commands().run(c));
    });
    expect(pill('Status')?.textContent).toContain('Todo');
    expect(pill('Assignee')?.textContent).toContain('Ada');
  });
});

describe('drafts (AC-3, E25)', () => {
  it('closing with content asks "Save as draft?"; Save sends draft.save with the team and fields', async () => {
    const app = new ComposerApp();
    await open(app);
    await setValue(titleInput(), 'Keep me');
    await keydown(titleInput(), 'Escape');
    const ask = dialogNamed('Save as draft?');
    expect(ask).toBeDefined();
    await click(buttonNamed('Save', ask));
    expect(app.ops()).toEqual(['draft.save']);
    expect(app.dispatched[0]?.input).toMatchObject({
      kind: 'composer',
      teamId: ENG,
      data: { title: 'Keep me', description: null, labelIds: [] },
    });
    expect(composer()).toBeUndefined();
  });

  it('E25: Discard drops the content, sends nothing and leaves the saved draft alone', async () => {
    const saved = draftRow({ teamId: ENG, data: { title: 'Saved before' } });
    const app = new ComposerApp({ drafts: [saved] });
    await open(app);
    await setValue(titleInput(), 'Changed after');
    await keydown(titleInput(), 'Escape');
    await click(buttonNamed('Discard', dialogNamed('Save as draft?')));
    expect(app.ops()).toEqual([]);
    expect(composer()).toBeUndefined();
    expect(app.drafts.get()).toEqual([saved]);
  });

  it('Save after a team change asks before replacing that team’s draft; Cancel keeps the composer', async () => {
    const theirs = draftRow({ teamId: DES, data: { title: 'Design draft' } });
    const app = new ComposerApp({ drafts: [theirs] });
    await open(app);
    await setValue(titleInput(), 'Started in ENG');
    await chooseTeam('Design');
    await keydown(titleInput(), 'Escape');
    await click(buttonNamed('Save', dialogNamed('Save as draft?')));
    const ask = dialogNamed(replaceDraftQuestion('DES'));
    expect(ask).toBeDefined();
    expect(app.ops()).toEqual([]);
    await click(buttonNamed('Cancel', ask));
    expect(dialogNamed(replaceDraftQuestion('DES'))).toBeUndefined();
    expect(titleInput().value).toBe('Started in ENG');
    expect(app.drafts.get()).toEqual([theirs]);
    // Asked again, Replace saves over it.
    await keydown(titleInput(), 'Escape');
    await click(buttonNamed('Save', dialogNamed('Save as draft?')));
    await click(buttonNamed('Replace', dialogNamed(replaceDraftQuestion('DES'))));
    expect(app.ops()).toEqual(['draft.save']);
    expect(app.dispatched[0]?.input).toMatchObject({
      teamId: DES,
      data: { title: 'Started in ENG' },
    });
    expect(composer()).toBeUndefined();
  });

  it('E7: a hidden team’s draft opened in the default team asks before replacing its draft', async () => {
    const hidden = draftRow({ teamId: SEC, data: { title: 'From SEC' } });
    const engs = draftRow({ teamId: ENG, data: { title: 'ENG draft' } });
    const app = new ComposerApp({ drafts: [hidden, engs] });
    mounted = await mountComposer(app, '/team/ENG/issues');
    const m = mounted;
    await inAct(() => {
      openComposerWith({ kind: 'draft', teamId: SEC }, (c) => m.commands().run(c));
    });
    expect(titleInput().value).toBe('From SEC');
    await keydown(titleInput(), 'Escape');
    await click(buttonNamed('Save', dialogNamed('Save as draft?')));
    expect(app.ops()).toEqual([]);
    await click(buttonNamed('Replace', dialogNamed(replaceDraftQuestion('ENG'))));
    // ENG's draft becomes this one, and the hidden team's draft moves with it.
    expect(app.ops()).toEqual(['draft.save', 'draft.discard']);
    expect(app.dispatched[0]?.input).toMatchObject({ teamId: ENG, data: { title: 'From SEC' } });
    expect(app.dispatched[1]?.input).toMatchObject({ kind: 'composer', teamId: SEC });
  });

  it('Save over the draft the composer restored asks nothing', async () => {
    const app = new ComposerApp({ drafts: [draftRow({ teamId: ENG, data: { title: 'Mine' } })] });
    await open(app);
    await setValue(titleInput(), 'Mine, edited');
    await keydown(titleInput(), 'Escape');
    await click(buttonNamed('Save', dialogNamed('Save as draft?')));
    expect(dialogNamed(replaceDraftQuestion('ENG'))).toBeUndefined();
    expect(app.ops()).toEqual(['draft.save']);
  });

  it('an empty composer closes without a prompt', async () => {
    const app = new ComposerApp();
    await open(app);
    await keydown(titleInput(), 'Escape');
    expect(dialogNamed('Save as draft?')).toBeUndefined();
    expect(composer()).toBeUndefined();
  });

  it('C restores the team’s draft with "Draft restored · Discard"; Discard clears it', async () => {
    const app = new ComposerApp({
      drafts: [draftRow({ teamId: ENG, data: { title: 'Restored title', labelIds: [LABEL_BUG] } })],
    });
    await open(app);
    expect(titleInput().value).toBe('Restored title');
    expect(composer()?.textContent).toContain('Draft restored');
    expect(pill('Labels')?.textContent).toContain('Bug');
    await click(buttonNamed('Discard', composer()));
    expect(app.ops()).toEqual(['draft.discard']);
    expect(titleInput().value).toBe('');
    expect(composer()?.textContent).not.toContain('Draft restored');
  });

  it('a restored draft drops what no longer resolves, with the note', async () => {
    const app = new ComposerApp({
      drafts: [
        draftRow({
          teamId: DES,
          data: { title: 'Moved', labelIds: [LABEL_FRONTEND, LABEL_BUG], statusId: ENG_TODO },
        }),
      ],
    });
    await open(app, '/team/DES/issues');
    expect(composer()?.textContent).toContain('Dropped: status Todo, label Frontend.');
    expect(pill('Labels')?.textContent).toContain('Bug');
  });
});

describe('changing team (AC-2, E8)', () => {
  it('E8: to a team without estimates, the estimate pill goes and the note names the value', async () => {
    const app = new ComposerApp({
      drafts: [draftRow({ teamId: ENG, data: { title: 'Sized', estimate: 3 } })],
    });
    await open(app);
    expect(pill('Estimate')?.textContent).toContain('3');
    await chooseTeam('Design');
    expect(pill('Team')?.textContent).toContain('DES');
    expect(pill('Estimate')).toBeUndefined();
    expect(composer()?.textContent).toContain('Dropped: estimate 3.');
    expect(titleInput().value).toBe('Sized');
  });
});
