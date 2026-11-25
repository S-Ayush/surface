// PLAN-010 S3 web half (SPEC-010 §3.2, §7.1): the labels pages render from the replica's rows. The
// table lists labels and groups by name with the usage columns as "—", groups are collapsed with
// an expand toggle, the footer counts the workspace labels a team inherits, the group type is a
// select, the row menu offers Move to workspace only on team labels, a reader of a public team
// sees the page read-only, and every member can edit the workspace page. Server-rendered markup;
// what happens once mounted (the create request, the dialogs) is `label-page-dom.test.tsx`
// (jsdom), the keys are `label-row-keys.test.tsx`, and the model (filter, expand, `Group/Label`)
// is `labels-model.test.ts`.
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AppModel } from '../src/app/AppModel.js';
import { TeamLabelsScreen, WorkspaceLabelsScreen } from '../src/features/labels/LabelsScreen.js';
import { FakeApp, TEAM, pageTree } from './label-fixtures.js';

async function render(app: AppModel, page: () => ReactNode): Promise<string> {
  return renderToString(await pageTree(app, page)).replaceAll('<!-- -->', '');
}

const teamPage = () => <TeamLabelsScreen params={{ key: 'ENG' }} />;
const workspacePage = () => <WorkspaceLabelsScreen />;

describe('Settings → Team → Labels', () => {
  it("lists the team's labels and groups by name in any case, groups collapsed", async () => {
    const html = await render(new FakeApp([TEAM]), teamPage);
    const order = ['bug fix', 'Perf', 'Scope', 'Size'].map((name) =>
      html.indexOf(`>${name}</span>`),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A label inside a group shows once its group is expanded, and workspace labels are elsewhere.
    expect(html).not.toContain('>Small</span>');
    expect(html).not.toContain('>Bug</span>');
    expect(html).toContain('aria-label="Expand Size"');
    expect(html).toContain('aria-expanded="false"');
  });

  it('shows the description in place, the usage columns as "—", and the created day', async () => {
    const html = await render(new FakeApp([TEAM]), teamPage);
    expect(html).toContain('value="Slow things"');
    expect(html).toContain('placeholder="Add description…"');
    expect(html).toMatch(/>Nov 1[2-4]<\/span>/);
    expect(html).toContain('>Used in</span>');
    expect(html).toContain('>Last applied</span>');
    expect(html).toContain('>—</span>');
  });

  it('offers a group type select on a group, set from the group', async () => {
    const html = await render(new FakeApp([TEAM]), teamPage);
    expect(html).toContain('aria-label="Group type of Size"');
    expect(html).toMatch(/aria-label="Group type of Scope"[^>]*>.*Group type: Multiple/);
    expect(html).not.toContain('aria-label="Group type of Perf"');
  });

  it('counts the workspace labels the team inherits, not archived ones and not groups', async () => {
    const html = await render(new FakeApp([TEAM]), teamPage);
    expect(html).toContain('2 labels inherited from workspace');
    expect(html).toContain('href="/settings/labels"');
  });

  it('makes each row an option of one listbox in the settings-row scope', async () => {
    const html = await render(new FakeApp([TEAM]), teamPage);
    expect(html).toContain('role="listbox"');
    expect(html.match(/role="option"/g)).toHaveLength(4);
    expect(html.match(/data-shortcut-scope="settings-row"/g)).toHaveLength(4);
    expect(html.match(/role="option"[^>]*tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/data-label-id=/g)).toHaveLength(4);
  });

  it('has New group, New label and the filter for a member', async () => {
    const html = await render(new FakeApp([TEAM]), teamPage);
    expect(html).toContain('>New group<');
    expect(html).toContain('>New label<');
    expect(html).toContain('aria-label="Filter by name"');
    expect(html).toContain('aria-label="Actions for Perf"');
  });

  it('is read-only for someone who is not a member, with "Join the team to edit"', async () => {
    const html = await render(new FakeApp([]), teamPage);
    expect(html).toContain('Join the team to edit');
    expect(html).not.toContain('>New label<');
    expect(html).not.toContain('aria-label="Actions for Perf"');
    expect(html).not.toContain('aria-label="Description of Perf"');
    expect(html).toContain('>Perf</span>');
  });

  it('lets an Admin who is not a member edit', async () => {
    const html = await render(new FakeApp([], 'admin'), teamPage);
    expect(html).not.toContain('Join the team to edit');
    expect(html).toContain('>New label<');
  });
});

describe('Settings → Labels (workspace)', () => {
  it('lists only workspace labels, and no inherited footer', async () => {
    const html = await render(new FakeApp([]), workspacePage);
    expect(html).toContain('>Bug</span>');
    expect(html).toContain('>Feature</span>');
    expect(html).not.toContain('>Perf</span>');
    expect(html).not.toContain('>Archived one</span>');
    expect(html).not.toContain('inherited from workspace');
  });

  it('is open to every member, a non-member of any team included (D9)', async () => {
    const html = await render(new FakeApp([]), workspacePage);
    expect(html).not.toContain('Join the team to edit');
    expect(html).toContain('>New label<');
    expect(html).toContain('aria-label="Actions for Bug"');
  });
});
