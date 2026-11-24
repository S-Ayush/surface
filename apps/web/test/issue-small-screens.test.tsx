/**
 * @vitest-environment jsdom
 */
// PLAN-012 S7a (SPEC-012 §7.3, AC-20, NFR-20): the small-screen layout switches. jsdom has no
// layout, so this checks the switches themselves (the panel's mode, the compact row, the
// full-screen composer, the stacked panel) and that the CSS has no fixed widths to overflow 375 px.
// The real 375 px pass is the story viewport run (local DoD) and S7b's by-hand check.
import { IssueRow, overlayManager } from '@surface/ui';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { PropertiesPanel } from '../src/features/issues/PropertiesPanel.js';
import { issueViewFromOutput, type IssueOutput } from '../src/features/issues/issue-view.js';
import { panelMode, usePanelMode } from '../src/features/issues/panel-layout.js';
import { ComposerApp, dialogNamed, mountComposer, type Mounted } from './composer-harness.js';
import { inAct } from './issue-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');

/** A `matchMedia` for a window `width` px wide that understands `(max-width: Npx)`. */
function setWidth(width: number): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => {
      const limit = Number(/max-width:\s*([\d.]+)px/.exec(query)?.[1] ?? Infinity);
      return {
        matches: width <= limit,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      };
    },
  });
}

let composer: Mounted | undefined;
afterEach(() => {
  composer?.unmount();
  composer = undefined;
  overlayManager.clear();
  document.body.innerHTML = '';
  if (original !== undefined) Object.defineProperty(window, 'matchMedia', original);
});

function modeAt(width: number): string {
  setWidth(width);
  const host = document.createElement('div');
  const root = createRoot(host);
  function Probe() {
    return <span>{usePanelMode()}</span>;
  }
  act(() => {
    root.render(<Probe />);
  });
  const text = host.textContent;
  act(() => {
    root.unmount();
  });
  return text;
}

describe('the issue page layout (AC-20)', () => {
  it('puts the panel inline from 1280 px, in a drawer from 768 to 1279 px and stacked below', () => {
    expect([1440, 1280, 1279, 1024, 768, 767, 375].map(modeAt)).toEqual([
      'inline',
      'inline',
      'drawer',
      'drawer',
      'drawer',
      'stacked',
      'stacked',
    ]);
    expect([1280, 1279, 768, 767].map(panelMode)).toEqual([
      'inline',
      'drawer',
      'drawer',
      'stacked',
    ]);
  });

  const ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
  const AT = '2026-11-12T10:00:00.000Z';
  const view = issueViewFromOutput({
    id: ID,
    identifier: 'ENG-42',
    teamKey: 'ENG',
    title: 'T',
    status: { id: ID, name: 'Todo', category: 'unstarted' },
    priority: 0,
    assignee: null,
    labels: [],
    estimate: null,
    dueDate: null,
    createdAt: AT,
    updatedAt: AT,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    deletedBy: null,
    url: 'x',
    creator: { id: ID, name: 'Ada' },
    startedAt: null,
    canceledAt: null,
    reactions: [],
    attachments: [],
    description: { markdown: '', json: { type: 'doc', content: [{ type: 'paragraph' }] } },
    version: 1,
  } satisfies IssueOutput);
  const now = new Date('2026-11-13T10:00:00.000Z');

  it('stacks the panel as a wrapping row of editable pills', () => {
    const stacked = renderToString(
      <PropertiesPanel view={view} now={now} stacked onPick={() => undefined} />,
    );
    const plain = renderToString(
      <PropertiesPanel view={view} now={now} onPick={() => undefined} />,
    );
    expect(stacked).toMatch(/class="[^"]*stacked/);
    expect(plain).not.toMatch(/class="[^"]*stacked/);
    expect(stacked).toContain('Status: Todo, change');
  });
});

describe('the list rows (AC-20)', () => {
  const props = {
    rowIndex: 2,
    identifier: 'ENG-42',
    title: 'Fix login',
    priority: 2,
    status: { name: 'Todo', category: 'unstarted', color: 'gray' },
    labels: [{ id: 'l1', name: 'Bug', color: 'red' }],
    estimate: { label: '3' },
    dueDate: { label: 'Nov 20' },
    assignee: { name: 'Ada' },
    createdLabel: 'Nov 6',
  } as const;

  it('shows priority, identifier, title, status and assignee only when compact', () => {
    const html = renderToString(<IssueRow {...props} compact />);
    const cells = [...html.matchAll(/role="gridcell"/g)];
    expect(cells).toHaveLength(5);
    expect(html).not.toContain('Bug');
    expect(html).not.toContain('Nov 6');
    expect(html).not.toContain('Nov 20');
    // Order: priority, identifier, title, status, assignee.
    const at = (text: string) => html.indexOf(text);
    expect(at('Priority:')).toBeLessThan(at('ENG-42'));
    expect(at('ENG-42')).toBeLessThan(at('Fix login'));
    expect(at('Fix login')).toBeLessThan(at('Status:'));
    expect(at('Status:')).toBeLessThan(at('Assignee:'));
  });

  it('shows every column when not compact', () => {
    const html = renderToString(<IssueRow {...props} />);
    expect(html).toContain('Bug');
    expect(html).toContain('Nov 6');
    expect(html).toContain('Nov 20');
  });
});

describe('the composer (AC-20)', () => {
  it('opens as a full-screen dialog below 768 px', async () => {
    composer = await mountComposer(new ComposerApp(), '/team/ENG/issues');
    const m = composer;
    await inAct(() => {
      m.commands().run('issue:create');
    });
    const dialog = dialogNamed('New issue');
    expect(dialog?.className).toMatch(/fullSmall/);
  });
});

describe('no fixed widths (AC-20)', () => {
  const files = [
    '../src/features/issues/issue-page.module.css',
    '../src/features/issues/IssueList.module.css',
    '../src/features/issues/composer.module.css',
    '../../../packages/ui/src/components/IssueRow/IssueRow.module.css',
    '../../../packages/ui/src/components/Dialog/Dialog.module.css',
  ];
  const css = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it.each(files)('%s has no width in px, only tokens, percentages and viewport units', (path) => {
    const fixed = css(path).match(/(?:^|\s)(?:min-|max-)?width:\s*\d[\d.]*px/gm);
    expect(fixed).toBeNull();
  });

  it('switches to one column and full screen under 768 px', () => {
    expect(css(files[0] ?? '')).toContain('@media (max-width: 767.98px)');
    expect(css(files[4] ?? '')).toMatch(/@media \(max-width: 767\.98px\)[\s\S]*\.fullSmall/);
  });
});
