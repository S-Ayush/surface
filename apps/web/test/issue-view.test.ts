// The issue page's data rules (SPEC-012 §3.4 items 5 and 8): the estimate row, the read-only view
// built from `issue.get`, relative times, and where the properties panel sits.
import { describe, expect, it } from 'vitest';
import {
  agoText,
  estimateRow,
  issueViewFromOutput,
  type IssueOutput,
} from '../src/features/issues/issue-view.js';
import { panelMode } from '../src/features/issues/panel-layout.js';

const ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
const AT = '2026-11-12T10:00:00.000Z';
const FIBONACCI = { scale: 'fibonacci', extended: false, allowZero: false } as const;

describe('estimateRow', () => {
  it('shows an empty row while the team uses estimates, and none when it does not', () => {
    expect(estimateRow({ estimate: null, estimateConfig: FIBONACCI })).toEqual({
      shown: true,
      value: null,
      offScale: false,
    });
    expect(estimateRow({ estimate: null, estimateConfig: { ...FIBONACCI, scale: 'off' } })).toEqual(
      {
        shown: false,
      },
    );
  });

  it('flags a value off the scale, including any value when the scale is off', () => {
    expect(estimateRow({ estimate: 5, estimateConfig: FIBONACCI })).toMatchObject({
      offScale: false,
    });
    expect(estimateRow({ estimate: 4, estimateConfig: FIBONACCI })).toMatchObject({
      offScale: true,
    });
    expect(
      estimateRow({ estimate: 4, estimateConfig: { ...FIBONACCI, scale: 'off' } }),
    ).toMatchObject({
      shown: true,
      offScale: true,
    });
  });

  it('shows a value plainly when the team’s settings are unknown', () => {
    expect(estimateRow({ estimate: 4, estimateConfig: null })).toEqual({
      shown: true,
      value: 4,
      offScale: false,
    });
  });
});

describe('issueViewFromOutput', () => {
  const output: IssueOutput = {
    id: ID,
    identifier: 'ENG-42',
    teamKey: 'ENG',
    title: 'T',
    status: { id: ID, name: 'Todo', category: 'unstarted' },
    priority: 9,
    assignee: null,
    labels: [{ id: ID, name: 'Bug', color: 'not-a-colour' }],
    estimate: null,
    dueDate: null,
    createdAt: AT,
    updatedAt: AT,
    completedAt: null,
    archivedAt: null,
    deletedAt: AT,
    deletedBy: null,
    url: 'x',
    creator: { id: ID, name: 'Ada' },
    startedAt: null,
    canceledAt: null,
    reactions: [],
    description: { markdown: '', json: { type: 'doc', content: [{ type: 'paragraph' }] } },
    version: 1,
  };

  it('reads the number and lifecycle, and falls back for values it does not know', () => {
    const view = issueViewFromOutput(output);
    expect(view).toMatchObject({
      number: 42,
      lifecycle: 'deleted',
      priority: 0,
      estimateConfig: null,
    });
    expect(view.labels[0]?.color).toBe('gray');
  });
});

describe('agoText', () => {
  const now = new Date('2026-11-12T12:00:00.000Z');
  it('reads minutes, hours and days, then a date', () => {
    expect(agoText('2026-11-12T11:59:30.000Z', now)).toBe('just now');
    expect(agoText('2026-11-12T11:30:00.000Z', now)).toMatch(/30/);
    expect(agoText('2026-11-12T10:00:00.000Z', now)).toMatch(/2/);
    expect(agoText('2026-11-01T10:00:00.000Z', now)).toBe('Nov 1');
    expect(agoText('garbage', now)).toBe('');
  });
});

describe('panelMode', () => {
  it('is inline from 1280 px, a drawer to 768 px and stacked below (SPEC-012 §7.3)', () => {
    expect(panelMode(1280)).toBe('inline');
    expect(panelMode(1279)).toBe('drawer');
    expect(panelMode(1024)).toBe('drawer');
    expect(panelMode(768)).toBe('drawer');
    expect(panelMode(767)).toBe('stacked');
    expect(panelMode(375)).toBe('stacked');
  });
});
