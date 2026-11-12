import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import panel from '../../stories/panel.module.css';
import { IssueRow, type IssueRowProperty, type IssueRowProps } from './IssueRow.js';

const meta = { title: 'Primitives/IssueRow' } satisfies Meta;
export default meta;
type Args = {
  onOpen: () => void;
  onPropertyClick: (property: IssueRowProperty, anchor: HTMLElement) => void;
};
type Story = StoryObj<Args>;

const base: Omit<IssueRowProps, 'rowIndex'> = {
  identifier: 'ENG-42',
  title: 'Fix login redirect after the session expires',
  priority: 2,
  status: { name: 'In Progress', category: 'started', color: 'amber' },
  labels: [
    { id: 'bug', name: 'Bug', color: 'red' },
    { id: 'web', name: 'Web', color: 'blue' },
  ],
  estimate: { label: '3' },
  dueDate: { label: 'Dec 3' },
  assignee: { name: 'Ada Lovelace' },
  createdLabel: 'Nov 6',
};

function Grid({ children, count }: { children: React.ReactNode; count: number }) {
  return (
    <div role="treegrid" aria-label="Issues" aria-rowcount={count} className={panel['listBox']}>
      {children}
    </div>
  );
}

export const Rows: Story = {
  render: () => (
    <Grid count={6}>
      <IssueRow {...base} rowIndex={1} tabIndex={0} />
      <IssueRow
        {...base}
        rowIndex={2}
        identifier="ENG-43"
        focused
        priority={1}
        title="Focused row"
      />
      <IssueRow
        {...base}
        rowIndex={3}
        identifier="ENG-…"
        pending
        title="Pending: the server has not confirmed it yet"
        labels={[]}
        assignee={null}
        dueDate={null}
        priority={0}
      />
      <IssueRow
        {...base}
        rowIndex={4}
        identifier="ENG-44"
        estimate={{ label: '7', offScale: true }}
        dueDate={{ label: 'Nov 1', overdue: true }}
        title="Off-scale estimate and an overdue date"
      />
      <IssueRow
        {...base}
        rowIndex={5}
        identifier="ENG-45"
        estimate={undefined}
        title="A team that does not use estimates"
        createdLabel="Nov 6, 2025"
      />
      <IssueRow
        {...base}
        rowIndex={6}
        identifier="ENG-46"
        title="A very long title that has to be cut with an ellipsis instead of pushing the other columns out of the row"
      />
    </Grid>
  ),
};

export const WithPickers: Story = {
  render: () => (
    <Grid count={1}>
      <IssueRow {...base} rowIndex={1} tabIndex={0} onPropertyClick={() => {}} onOpen={() => {}} />
    </Grid>
  ),
};

/** Below 768 px: priority, identifier, title, status and assignee. */
export const Compact: Story = {
  render: () => (
    <div style={{ maxWidth: 375 }}>
      <Grid count={2}>
        <IssueRow {...base} rowIndex={1} compact tabIndex={0} />
        <IssueRow {...base} rowIndex={2} compact identifier="ENG-43" assignee={null} priority={1} />
      </Grid>
    </div>
  ),
};

export const Interactions: Story = {
  args: { onOpen: fn(), onPropertyClick: fn() },
  render: (args) => (
    <Grid count={1}>
      <IssueRow
        {...base}
        rowIndex={1}
        tabIndex={0}
        onOpen={args.onOpen}
        onPropertyClick={args.onPropertyClick}
      />
    </Grid>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // The row is the roving tab stop; pills are reached by their shortcuts, not by Tab.
    await userEvent.tab();
    await expect(canvas.getByRole('row')).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('row')).not.toHaveFocus();
    // A pill opens its picker and doesn't open the issue.
    await userEvent.click(canvas.getByRole('button', { name: 'Priority: High, change' }));
    await expect(args.onPropertyClick).toHaveBeenCalledWith('priority', expect.any(HTMLElement));
    await expect(args.onOpen).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByText('Fix login redirect after the session expires'));
    await expect(args.onOpen).toHaveBeenCalledOnce();
  },
};
