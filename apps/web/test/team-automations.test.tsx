/**
 * @vitest-environment jsdom
 */
// PLAN-015 S3, SPEC-015 §3.2, AC-16 (component half): the Automations page offers only 1, 3, 6, 9
// and 12 months; auto-archive defaults to 6 and has no off switch; auto-close is off by default,
// turns on at 6 months, and offers only the team's Canceled-category statuses; every change saves
// at once as one `team.updateAutomations` with only that field; the M3 toggles are not shown; a
// non-member sees the controls disabled with the reason.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamAutomationsScreen } from '../src/features/teams/TeamAutomationsScreen.js';
import { clearToasts, toasts } from './comment-harness.js';
import { ENG, EstimateApp, pageTree, status } from './estimate-fixtures.js';

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
  await act(async () => {
    root?.unmount();
    await Promise.resolve();
  });
  root = undefined;
  host.remove();
});

const CANCELED = '0192f0c1-7e5a-7b3c-9d4e-0000000000c1';
const WONT_DO = '0192f0c1-7e5a-7b3c-9d4e-0000000000c2';
const canceledStatuses = [
  status(WONT_DO, 'Won’t do', 'canceled', 'a1'),
  status(CANCELED, 'Canceled', 'canceled', 'a0'),
];

async function mount(app: EstimateApp, page: () => ReactNode): Promise<void> {
  const tree = await pageTree(app, page);
  root = createRoot(host);
  await act(async () => {
    root?.render(tree);
    await Promise.resolve();
  });
}

const page = () => <TeamAutomationsScreen params={{ key: 'ENG' }} />;
const selects = () => [...document.querySelectorAll<HTMLSelectElement>('select')];
const selectLabelled = (text: string) =>
  selects().find((s) => s.closest('label')?.textContent?.startsWith(text));
const switches = () => [...document.querySelectorAll<HTMLElement>('[role="switch"]')];
const optionTexts = (el: HTMLSelectElement | undefined) =>
  [...(el?.options ?? [])].map((o) => o.textContent);

async function choose(el: HTMLSelectElement | undefined, value: string): Promise<void> {
  if (el === undefined) throw new Error('no select');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

async function toggleAutoClose(): Promise<void> {
  const el = switches()[0];
  if (el === undefined) throw new Error('no switch');
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

const MONTHS = ['1 month', '3 months', '6 months', '9 months', '12 months'];

describe('Settings → Team → Automations (SPEC-015 §3.2)', () => {
  it('offers auto-archive in 1, 3, 6, 9 and 12 months, defaulting to 6, with the spec’s copy and no off switch', async () => {
    await mount(new EstimateApp([ENG], {}, 'member', { statuses: canceledStatuses }), page);
    const archive = selectLabelled('Auto-archive closed items after');
    expect(optionTexts(archive)).toEqual(MONTHS);
    expect(archive?.value).toBe('6');
    expect(document.body.textContent).toContain(
      'Automatically archive closed issues (completed, canceled, or duplicate) after the selected period. Changes apply within a day.',
    );
    // The only switch on the page is auto-close's.
    expect(switches()).toHaveLength(1);
  });

  it('shows auto-close off by default, with its selects hidden and no M3 toggles', async () => {
    await mount(new EstimateApp([ENG], {}, 'member', { statuses: canceledStatuses }), page);
    expect(switches()[0]?.getAttribute('aria-checked')).toBe('false');
    expect(selectLabelled('Close after being stale for')).toBeUndefined();
    expect(selectLabelled('When closing stale issues, set status to')).toBeUndefined();
    expect(document.body.textContent).not.toMatch(/parent issues|sub-issues/i);
  });

  it('turns auto-close on at 6 months with one team.updateAutomations', async () => {
    const app = new EstimateApp([ENG], {}, 'member', { statuses: canceledStatuses });
    await mount(app, page);
    await toggleAutoClose();
    expect(app.dispatched).toEqual([
      { op: 'team.updateAutomations', input: { team: 'ENG', autoCloseMonths: 6 } },
    ]);
  });

  it('shows the auto-close settings once on: months from the team, and only Canceled statuses, first by position', async () => {
    await mount(
      new EstimateApp([ENG], { autoCloseMonths: 9, autoCloseStatusId: WONT_DO }, 'member', {
        statuses: canceledStatuses,
      }),
      page,
    );
    expect(switches()[0]?.getAttribute('aria-checked')).toBe('true');
    const months = selectLabelled('Close after being stale for');
    expect(optionTexts(months)).toEqual(MONTHS);
    expect(months?.value).toBe('9');
    const statuses = selectLabelled('When closing stale issues, set status to');
    // Backlog, Todo, In Progress and Done are not offered.
    expect(optionTexts(statuses)).toEqual(['Canceled', 'Won’t do']);
    expect(statuses?.value).toBe(WONT_DO);
  });

  it('saves each change at once with only its own field', async () => {
    const app = new EstimateApp(
      [ENG],
      { autoCloseMonths: 6, autoCloseStatusId: CANCELED },
      'member',
      { statuses: canceledStatuses },
    );
    await mount(app, page);
    await choose(selectLabelled('Auto-archive closed items after'), '3');
    await choose(selectLabelled('Close after being stale for'), '12');
    await choose(selectLabelled('When closing stale issues, set status to'), WONT_DO);
    await toggleAutoClose();
    expect(app.dispatched.map((d) => d.input)).toEqual([
      { team: 'ENG', autoArchiveMonths: 3 },
      { team: 'ENG', autoCloseMonths: 12 },
      { team: 'ENG', autoCloseStatus: WONT_DO },
      { team: 'ENG', autoCloseMonths: null },
    ]);
  });

  it('reports a change the store did not take as a toast, with no inline alert', async () => {
    const app = new EstimateApp([ENG], {}, 'member', { statuses: canceledStatuses });
    app.failure.message = 'That change could not be saved. Try again.';
    await mount(app, page);
    await choose(selectLabelled('Auto-archive closed items after'), '1');
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(app.dispatched).toEqual([]);
    expect(toasts()).toContain('That change could not be saved. Try again.');
    clearToasts();
  });

  it('cannot turn auto-close on in a team with no Canceled status, and says why', async () => {
    await mount(new EstimateApp([ENG]), page);
    expect(switches()[0]?.hasAttribute('disabled')).toBe(true);
    expect(document.body.textContent).toContain('Auto-close needs a Canceled status.');
  });

  it('disables the controls for a non-member and says who may change them', async () => {
    await mount(
      new EstimateApp([], { autoCloseMonths: 6, autoCloseStatusId: CANCELED }, 'member', {
        statuses: canceledStatuses,
      }),
      page,
    );
    expect(selects().every((s) => s.disabled)).toBe(true);
    expect(switches().every((s) => s.hasAttribute('disabled'))).toBe(true);
    expect(document.body.textContent).toContain(
      'Only members of ENG and Admins can change these settings.',
    );
  });
});
