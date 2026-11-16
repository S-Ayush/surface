/**
 * @vitest-environment jsdom
 */
// PLAN-010 S5, SPEC-010 §3.2 and §5 (D15, AC-26): the labels page's Used in, Issues and Last
// applied columns come from the server's `label.usage`, "—" until it answers and offline, and the
// delete dialog's N is the label's Issues count (only issues the actor can see), left out when
// there is no answer.
import { Label } from '@surface/domain/model';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppModel } from '../src/app/AppModel.js';
import { TeamLabelsScreen, WorkspaceLabelsScreen } from '../src/features/labels/LabelsScreen.js';
import type {
  LabelUsageInput,
  LabelUsageOutput,
  SettingsReads,
} from '../src/features/teams/settings-reads.js';
import { FakeApp, SILENT_READS, TEAM, pageTree } from './label-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class NoResize {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoResize;
window.scrollTo = () => undefined;

let host: HTMLElement;
let root: Root | undefined;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(async () => {
  await settle(() => root?.unmount());
  root = undefined;
  host.remove();
});

async function settle(change: () => void = () => undefined): Promise<void> {
  await act(async () => {
    change();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function mount(app: AppModel, page: () => ReactNode, reads: SettingsReads): Promise<void> {
  const tree = await pageTree(app, page, reads);
  root = createRoot(host);
  await settle(() => root?.render(tree));
}

async function press(button: Element | null | undefined): Promise<void> {
  if (!(button instanceof HTMLElement)) throw new Error('no such button');
  await settle(() => {
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    button.click();
  });
}

const teamPage = () => <TeamLabelsScreen params={{ key: 'ENG' }} />;
const workspacePage = () => <WorkspaceLabelsScreen />;

type Usage = { issues: number; teams: string[]; lastAppliedAt: string | null };

/**
 * A fake `label.usage` that answers `usage` (by label name) for the labels of the app's replica,
 * and records what it was asked.
 */
function usageReads(app: FakeApp, usage: Record<string, Usage>) {
  const asked: LabelUsageInput[] = [];
  const reads: SettingsReads = {
    ...SILENT_READS,
    labelUsage: (input) => {
      asked.push(input);
      const rows = (app.store?.pool.all(Label) ?? []).flatMap(
        (label): LabelUsageOutput['labels'] => {
          const found = usage[label.name];
          if (found === undefined) return [];
          return [
            {
              label: { id: label.id, name: label.name },
              issues: found.issues,
              teams: found.teams.map((key, i) => ({ id: `team-${i}`, key, name: key })),
              lastAppliedAt: found.lastAppliedAt,
            },
          ];
        },
      );
      return Promise.resolve({ ok: true, result: { labels: rows } });
    },
  };
  return { reads, asked };
}

/** The usage cells of the row named `name`: Used in, Issues, Last applied. */
function columns(name: string): string[] {
  const row = [...document.querySelectorAll('[data-label-id]')].find((el) =>
    [...el.querySelectorAll('span')].some((s) => s.textContent === name),
  );
  if (row === undefined) throw new Error(`no row ${name}`);
  return ['used-in', 'issues', 'last-applied'].map(
    (column) => row.querySelector(`[data-column="${column}"]`)?.textContent ?? '',
  );
}

async function openDelete(name: string): Promise<string> {
  await press(document.querySelector(`button[aria-label="Actions for ${name}"]`));
  await press(
    [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === 'Delete…',
    ),
  );
  return document.querySelector('[role="dialog"]')?.textContent ?? '';
}

describe('the usage columns (§3.2, AC-26)', () => {
  it('asks label.usage for the team’s labels and shows Used in, Issues and Last applied', async () => {
    const app = new FakeApp([TEAM]);
    const { reads, asked } = usageReads(app, {
      Perf: { issues: 3, teams: ['ENG', 'DES'], lastAppliedAt: '2026-11-10T08:30:00.000Z' },
      'bug fix': { issues: 0, teams: [], lastAppliedAt: null },
    });
    await mount(app, teamPage, reads);
    expect(asked).toEqual([{ team: 'ENG', scope: 'team' }]);
    expect(columns('Perf')).toEqual(['ENG, DES', '3', '2026-11-10']);
    expect(columns('bug fix')).toEqual(['', '0', '']);
  });

  it('asks for the workspace’s labels on the workspace page', async () => {
    const app = new FakeApp([]);
    const { reads, asked } = usageReads(app, {
      Bug: { issues: 7, teams: ['ENG'], lastAppliedAt: '2026-11-12T00:00:00.000Z' },
    });
    await mount(app, workspacePage, reads);
    expect(asked).toEqual([{ scope: 'workspace' }]);
    expect(columns('Bug')).toEqual(['ENG', '7', '2026-11-12']);
  });

  it('shows "—" in every usage column until label.usage answers', async () => {
    await mount(new FakeApp([TEAM]), teamPage, SILENT_READS);
    expect(columns('Perf')).toEqual(['—', '—', '—']);
  });

  it('shows "—" offline and asks nothing', async () => {
    const app = new FakeApp([TEAM]).goOffline();
    const { reads, asked } = usageReads(app, {
      Perf: { issues: 3, teams: ['ENG'], lastAppliedAt: null },
    });
    await mount(app, teamPage, reads);
    expect(asked).toEqual([]);
    expect(columns('Perf')).toEqual(['—', '—', '—']);
  });

  it('asks again once when the tab becomes visible, and not on focus alone', async () => {
    const app = new FakeApp([TEAM]);
    const { reads, asked } = usageReads(app, {});
    await mount(app, teamPage, reads);
    await settle(() => window.dispatchEvent(new Event('focus')));
    expect(asked).toHaveLength(1);
    await settle(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(asked).toHaveLength(2);
  });
});

describe('the delete dialog’s count (§3.2 item 7)', () => {
  it('says how many issues the label will be removed from, from its Issues count', async () => {
    const app = new FakeApp([TEAM]);
    const { reads } = usageReads(app, {
      Perf: { issues: 3, teams: ['ENG'], lastAppliedAt: null },
      'bug fix': { issues: 1, teams: ['ENG'], lastAppliedAt: null },
    });
    await mount(app, teamPage, reads);
    expect(await openDelete('Perf')).toContain(
      "It will be removed from 3 issues. This can't be undone.",
    );
  });

  it('says "1 issue" for one', async () => {
    const app = new FakeApp([TEAM]);
    const { reads } = usageReads(app, { Perf: { issues: 1, teams: ['ENG'], lastAppliedAt: null } });
    await mount(app, teamPage, reads);
    expect(await openDelete('Perf')).toContain(
      "It will be removed from 1 issue. This can't be undone.",
    );
  });

  it('leaves the count out offline', async () => {
    const app = new FakeApp([TEAM]).goOffline();
    const { reads } = usageReads(app, { Perf: { issues: 3, teams: ['ENG'], lastAppliedAt: null } });
    await mount(app, teamPage, reads);
    expect(await openDelete('Perf')).toContain(
      "It will be removed from every issue that has it. This can't be undone.",
    );
  });
});
