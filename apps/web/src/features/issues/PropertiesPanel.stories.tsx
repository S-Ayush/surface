// Stories for the issue page's properties panel (PLAN-012 S4b, SPEC-012 §3.4 item 5, AC-11 and
// AC-26 story halves): editable pills, an off-scale estimate, the read-only panel of an archived
// issue, and the stacked row below 768 px. Plain CSF without Storybook imports; axe runs on every
// story in light and dark.
import type { ReactNode } from 'react';
import { PropertiesPanel } from './PropertiesPanel.js';
import type { IssueView } from './issue-view.js';

export default { title: 'Domain/PropertiesPanel' };

const NOW = new Date('2026-11-16T12:00:00.000Z');

const VIEW: IssueView = {
  id: '0192f0c1-7e5a-7b3c-9d4e-0000000000b1',
  teamId: '0192f0c1-7e5a-7b3c-9d4e-0000000000e1',
  teamKey: 'ENG',
  number: 42,
  identifier: 'ENG-42',
  title: 'Login page flickers',
  status: { name: 'In Progress', category: 'started', color: 'yellow' },
  priority: 2,
  assignee: { name: 'Iris West' },
  labels: [
    { id: 'l1', name: 'Bug', color: 'red' },
    { id: 'l2', name: 'Frontend', color: 'blue' },
  ],
  estimate: 3,
  dueDate: '2026-11-20',
  creatorName: 'Ada Lovelace',
  createdAt: '2026-11-06T10:00:00.000Z',
  updatedAt: '2026-11-16T10:00:00.000Z',
  lifecycle: 'live',
  estimateConfig: { scale: 'fibonacci', extended: false, allowZero: false },
};

const noop = () => undefined;

function Panel({ children }: { children: ReactNode }) {
  return <div style={{ width: 'var(--properties-width)' }}>{children}</div>;
}

/** A live issue: each pill opens its picker. */
export const Editable = {
  render: () => (
    <Panel>
      <PropertiesPanel view={VIEW} now={NOW} onPick={noop} />
    </Panel>
  ),
};

/** An estimate the team's scale doesn't have shows as its number with the "Off scale" hint. */
export const OffScale = {
  render: () => (
    <Panel>
      <PropertiesPanel view={{ ...VIEW, estimate: 4 }} now={NOW} onPick={noop} />
    </Panel>
  ),
};

/** An archived issue (or one read from the server): the pills show but don't open (AC-26). */
export const ReadOnly = {
  render: () => (
    <Panel>
      <PropertiesPanel
        view={{ ...VIEW, lifecycle: 'archived', status: { ...VIEW.status, color: 'gray' } }}
        now={NOW}
      />
    </Panel>
  ),
};

/** Below 768 px the properties wrap as a row of pills under the title (SPEC-012 §7.3). */
export const Stacked = {
  render: () => (
    <div style={{ maxWidth: 'var(--content-max-width)' }}>
      <PropertiesPanel view={VIEW} now={NOW} onPick={noop} stacked />
    </div>
  ),
};
