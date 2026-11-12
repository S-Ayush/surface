// Server-rendered markup of the PLAN-012 S2 components: roles, names and states (AC-19). Interaction
// and axe run in the browser (`pnpm test:storybook`); visuals in `pnpm test:visual`.
import { readdirSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EditableTitle } from '../src/components/EditableTitle/EditableTitle.js';
import { GroupHeader } from '../src/components/GroupHeader/GroupHeader.js';
import { IssueRow } from '../src/components/IssueRow/IssueRow.js';
import { LabelChip } from '../src/components/LabelChip/LabelChip.js';
import { PriorityIcon } from '../src/components/PriorityIcon/PriorityIcon.js';
import { PropertyPill } from '../src/components/PropertyPill/PropertyPill.js';
import { StatusIcon } from '../src/components/StatusIcon/StatusIcon.js';
import { VirtualList } from '../src/components/VirtualList/VirtualList.js';
import { DatePicker } from '../src/components/DatePicker/DatePicker.js';
import { PlatformProvider } from '../src/platform.js';

const render = (node: React.ReactElement) =>
  renderToStaticMarkup(<PlatformProvider platform="mac">{node}</PlatformProvider>);

const COMPONENTS_DIR = new URL('../src/components/', import.meta.url);
const S2_COMPONENTS = [
  'StatusIcon',
  'PriorityIcon',
  'LabelChip',
  'PropertyPill',
  'PropertyPicker',
  'DatePicker',
  'GroupHeader',
  'IssueRow',
  'EditableTitle',
  'VirtualList',
];

describe('PLAN-012 S2 inventory', () => {
  it('has every component, each with stories (visual baselines and story tests come from them)', () => {
    const dirs = readdirSync(COMPONENTS_DIR);
    for (const name of S2_COMPONENTS) {
      expect(dirs, name).toContain(name);
      expect(readdirSync(new URL(`${name}/`, COMPONENTS_DIR)), name).toContain(
        `${name}.stories.tsx`,
      );
    }
  });
});

describe('StatusIcon and PriorityIcon', () => {
  it('are decorative without a label and named with one', () => {
    expect(render(<StatusIcon category="started" />)).toContain('aria-hidden="true"');
    const named = render(<StatusIcon category="started" label="In Progress" />);
    expect(named).toContain('role="img"');
    expect(named).toContain('aria-label="In Progress"');
    expect(render(<PriorityIcon priority={1} />)).toContain('aria-hidden="true"');
    expect(render(<PriorityIcon priority={2} label />)).toContain('aria-label="High"');
  });

  it('draw a different shape for every category and priority, not just a colour', () => {
    const categories = [
      'triage',
      'backlog',
      'unstarted',
      'started',
      'completed',
      'canceled',
      'duplicate',
    ] as const;
    const shapes = categories.map((c) =>
      render(<StatusIcon category={c} />).replace(/class="[^"]*"/g, ''),
    );
    expect(new Set(shapes).size).toBe(categories.length);
    const bars = ([0, 1, 2, 3, 4] as const).map((p) => render(<PriorityIcon priority={p} />));
    expect(new Set(bars).size).toBe(5);
  });

  it('fill 3, 2 and 1 bars for High, Medium and Low', () => {
    const count = (priority: 2 | 3 | 4) =>
      render(<PriorityIcon priority={priority} />).match(/class="[^"]*on[^"]*"/g)?.length ?? 0;
    expect([count(2), count(3), count(4)]).toEqual([3, 2, 1]);
  });
});

describe('LabelChip', () => {
  it('shows the name, and a named remove button only in edit mode', () => {
    expect(render(<LabelChip name="Bug" color="red" />)).not.toContain('<button');
    const html = render(<LabelChip name="Bug" color="red" onRemove={() => {}} />);
    expect(html).toContain('aria-label="Remove label Bug"');
    expect(html).toContain('var(--label-red)');
  });
});

describe('PropertyPill', () => {
  it('is a button named "Status: In Progress, change"', () => {
    const html = render(<PropertyPill property="Status" value="In Progress" />);
    expect(html).toContain('<button');
    expect(html).toContain('>Status: In Progress, change<');
  });

  it('names an empty value "none" and keeps a placeholder for hover', () => {
    const html = render(<PropertyPill property="Assignee" value={null} />);
    expect(html).toContain('>Assignee: none, change<');
    expect(html).toContain('Set assignee');
  });

  it('is plain text with the property read first when read-only, and nothing when empty', () => {
    const html = render(<PropertyPill property="Status" value="Done" readOnly />);
    expect(html).not.toContain('<button');
    expect(html).toContain('Status: Done');
    expect(render(<PropertyPill property="Due date" value={null} readOnly />)).not.toContain(
      'Set due date',
    );
  });
});

describe('GroupHeader', () => {
  it('is a row named with its count and state, with aria-expanded (SPEC-012 §7.4)', () => {
    const open = render(
      <GroupHeader
        name="In Progress"
        count={12}
        collapsed={false}
        onToggle={() => {}}
        rowIndex={1}
      />,
    );
    expect(open).toContain('role="row"');
    expect(open).toContain('aria-rowindex="1"');
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('aria-label="In Progress, 12 issues, expanded"');
    const closed = render(
      <GroupHeader name="Done" count={1} collapsed onToggle={() => {}} rowIndex={9} />,
    );
    expect(closed).toContain('aria-label="Done, 1 issue, collapsed"');
    expect(closed).toContain('aria-expanded="false"');
  });

  it('shows the add button only when a group can take an issue', () => {
    const base = { name: 'Todo', count: 0, collapsed: false, onToggle: () => {}, rowIndex: 1 };
    expect(render(<GroupHeader {...base} />)).not.toContain('Add issue to Todo');
    expect(render(<GroupHeader {...base} onAdd={() => {}} />)).toContain(
      'aria-label="Add issue to Todo"',
    );
  });
});

describe('IssueRow', () => {
  const row = {
    rowIndex: 4,
    identifier: 'ENG-42',
    title: 'Fix login redirect',
    priority: 2 as const,
    status: { name: 'In Progress', category: 'started' as const, color: 'amber' as const },
    labels: [{ id: 'l1', name: 'Bug', color: 'red' as const }],
    estimate: { label: '3' },
    dueDate: { label: 'Dec 3' },
    assignee: { name: 'Ada Lovelace' },
    createdLabel: 'Nov 6',
  };

  it('is a level-2 treegrid row by default, and takes another level', () => {
    expect(render(<IssueRow {...row} />)).toContain('aria-level="2"');
    expect(render(<IssueRow {...row} level={3} />)).toContain('aria-level="3"');
  });

  it('is a grid row with an index and a cell per column', () => {
    const html = render(<IssueRow {...row} />);
    expect(html).toContain('role="row"');
    expect(html).toContain('aria-rowindex="4"');
    expect(html.match(/role="gridcell"/g)).toHaveLength(9);
    for (const text of ['ENG-42', 'Fix login redirect', 'Bug', 'Dec 3', 'Nov 6'])
      expect(html).toContain(text);
  });

  it('shows read-only pills until a property handler is given, then named buttons', () => {
    expect(render(<IssueRow {...row} />)).not.toContain('<button');
    const html = render(<IssueRow {...row} onPropertyClick={() => {}} />);
    expect(html).toContain('>Status: In Progress, change<');
    expect(html).toContain('>Priority: High, change<');
    expect(html).toContain('>Assignee: Ada Lovelace, change<');
    expect(html).toContain('>Estimate: 3, change<');
    expect(html).toContain('>Labels: Bug, change<');
    expect(html).toContain('>Due date: Dec 3, change<');
  });

  it('hides the estimate column when the team does not use estimates', () => {
    const { estimate: _estimate, ...withoutEstimate } = row;
    expect(render(<IssueRow {...withoutEstimate} />).match(/role="gridcell"/g)).toHaveLength(8);
  });

  it('shows priority, identifier, title, status and assignee only in the compact variant', () => {
    const html = render(<IssueRow {...row} compact />);
    expect(html.match(/role="gridcell"/g)).toHaveLength(5);
    expect(html).not.toContain('Bug');
    expect(html).not.toContain('Nov 6');
    expect(html).toContain('data-compact');
  });

  it('marks a pending issue and takes the roving tabindex', () => {
    const html = render(<IssueRow {...row} identifier="ENG-…" pending tabIndex={0} focused />);
    expect(html).toContain('data-pending');
    expect(html).toContain('data-focused');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('ENG-…');
  });
});

describe('EditableTitle', () => {
  const props = { value: 'Fix login', onEditingChange: () => {}, onSave: () => {} };

  it('shows a heading with a button that starts the edit', () => {
    const html = render(<EditableTitle {...props} editing={false} />);
    expect(html).toContain('<h1');
    expect(html).toContain('<button');
    expect(html).toContain('Edit title');
  });

  it('shows a named field while editing', () => {
    const html = render(<EditableTitle {...props} editing />);
    expect(html).toContain('<input');
    expect(html).toContain('aria-label="Issue title"');
    expect(html).toContain('maxLength="255"');
  });

  it('is plain text when read-only, even while "editing"', () => {
    const html = render(<EditableTitle {...props} editing readOnly />);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
    expect(html).toContain('Fix login');
  });
});

const rowHeight = () => 36;

describe('VirtualList', () => {
  it('renders a treegrid with aria-rowcount for every item but mounts only a window', () => {
    const html = render(
      <div style={{ height: 360 }}>
        <VirtualList
          aria-label="Issues in ENG"
          count={10_000}
          itemHeight={rowHeight}
          initialViewportHeight={360}
          overscan={4}
          renderItem={({ index, style, tabIndex }) => (
            <div
              key={index}
              role="row"
              aria-rowindex={index + 1}
              style={style}
              tabIndex={tabIndex}
            />
          )}
        />
      </div>,
    );
    expect(html).toContain('role="treegrid"');
    expect(html).toContain('aria-rowcount="10000"');
    expect(html).toContain('aria-label="Issues in ENG"');
    expect(html.match(/role="row"/g)).toHaveLength(10 + 1 + 4);
    expect(html).toContain('aria-rowindex="1"');
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  });

  it('keeps the pinned row mounted and as the only tab stop', () => {
    const html = render(
      <VirtualList
        aria-label="Issues"
        count={1_000}
        itemHeight={rowHeight}
        initialViewportHeight={360}
        pinnedIndex={700}
        renderItem={({ index, style, tabIndex }) => (
          <div key={index} role="row" aria-rowindex={index + 1} style={style} tabIndex={tabIndex} />
        )}
      />,
    );
    expect(html).toContain('aria-rowindex="701"');
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toMatch(
      /aria-rowindex="701"[^>]*tabindex="0"|tabindex="0"[^>]*aria-rowindex="701"/,
    );
  });
});

describe('DatePicker', () => {
  it('has a named field, a month grid with named days and a No due date button', () => {
    const html = render(
      <DatePicker
        value="2026-12-03"
        today="2026-11-12"
        locale="en-US"
        parse={() => null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Due date"');
    expect(html).toContain('role="grid"');
    expect(html).toContain('aria-label="December 2026"');
    expect(html).toContain('aria-label="Thursday, December 3, 2026"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('No due date');
    expect(html.match(/tabindex="0"/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('shows today in the month when nothing is set, and disables No due date', () => {
    const html = render(
      <DatePicker
        value={null}
        today="2026-11-12"
        locale="en-US"
        parse={() => null}
        onChange={() => {}}
      />,
    );
    expect(html).toContain('aria-label="November 2026"');
    expect(html).toContain('aria-current="date"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*(<[^>]*>)*[^<]*No due date/);
  });
});
