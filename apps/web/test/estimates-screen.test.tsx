/**
 * @vitest-environment jsdom
 */
// PLAN-010 S4, SPEC-010 §3.3: the estimates page. The select offers the five scales with their
// value lists (D12); with the scale off the toggles are hidden and the note says the stored
// values are kept (E5, D21); every change saves at once, as one `team.setEstimates` with only
// that field; and a non-member sees the controls disabled with the reason.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EstimatesScreen } from '../src/features/estimates/EstimatesScreen.js';
import { SCALE_OPTIONS } from '../src/features/estimates/model.js';
import { ENG, EstimateApp, pageTree } from './estimate-fixtures.js';

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

async function mount(app: EstimateApp, page: () => ReactNode): Promise<void> {
  const tree = await pageTree(app, page);
  root = createRoot(host);
  await act(async () => {
    root?.render(tree);
    await Promise.resolve();
  });
}

const page = () => <EstimatesScreen params={{ key: 'ENG' }} />;
const select = () => document.querySelector<HTMLSelectElement>('select');
const switches = () => [...document.querySelectorAll<HTMLElement>('[role="switch"]')];
const labelsOf = () =>
  switches().map((el) => document.querySelector(`label[for="${el.id}"]`)?.textContent);

async function choose(value: string): Promise<void> {
  const el = select();
  if (el === null) throw new Error('no select');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

async function toggle(label: string): Promise<void> {
  const el = switches().find(
    (s) => document.querySelector(`label[for="${s.id}"]`)?.textContent === label,
  );
  if (el === undefined) throw new Error(`no switch ${label}`);
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

describe('model', () => {
  it('lists the scales in Linear’s order with their values from the domain', () => {
    expect(SCALE_OPTIONS.map((o) => o.label)).toEqual([
      'Not in use',
      'Exponential (1, 2, 4, 8, 16 Points)',
      'Fibonacci (1, 2, 3, 5, 8 Points)',
      'Linear (1, 2, 3, 4, 5 Points)',
      'T-Shirt (XS, S, M, L, XL)',
    ]);
  });
});

describe('Settings → Team → Estimates', () => {
  it('hides the toggles while estimates are off, and says the values are kept (E5)', async () => {
    await mount(new EstimateApp([ENG]), page);
    expect(select()?.value).toBe('off');
    expect(switches()).toHaveLength(0);
    expect(document.body.textContent).toContain('Values already set on issues are kept.');
  });

  it('shows the three toggles once a scale is on, set from the team', async () => {
    await mount(
      new EstimateApp([ENG], { estimateScale: 'fibonacci', estimateAllowZero: true }),
      page,
    );
    expect(select()?.value).toBe('fibonacci');
    expect(labelsOf()).toEqual([
      'Extended',
      'Allow zero estimates',
      'Count unestimated issues as 1 point',
    ]);
    expect(switches().map((s) => s.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'true',
    ]);
  });

  it('saves a new scale at once, as a team.setEstimates with only the scale', async () => {
    const app = new EstimateApp([ENG]);
    await mount(app, page);
    await choose('tshirt');
    expect(app.dispatched).toEqual([
      { op: 'team.setEstimates', input: { team: 'ENG', scale: 'tshirt' } },
    ]);
  });

  it('saves each toggle at once with only its own field', async () => {
    const app = new EstimateApp([ENG], { estimateScale: 'linear' });
    await mount(app, page);
    await toggle('Extended');
    await toggle('Allow zero estimates');
    await toggle('Count unestimated issues as 1 point');
    expect(app.dispatched.map((d) => d.input)).toEqual([
      { team: 'ENG', extended: true },
      { team: 'ENG', allowZero: true },
      { team: 'ENG', countUnestimatedAsOne: false },
    ]);
  });

  it('disables the controls for a non-member and says who may change them', async () => {
    await mount(new EstimateApp([], { estimateScale: 'linear' }), page);
    expect(select()?.disabled).toBe(true);
    expect(switches().every((s) => s.hasAttribute('disabled'))).toBe(true);
    expect(document.body.textContent).toContain(
      'Only members of ENG and Admins can change these settings.',
    );
  });
});
