import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { StatusIcon } from '../StatusIcon/StatusIcon.js';
import { GroupHeader } from './GroupHeader.js';

const meta = { title: 'Primitives/GroupHeader' } satisfies Meta;
export default meta;
type Args = { onAdd: () => void };
type Story = StoryObj<Args>;

/** Group headers are rows of a grid, so the stories wrap them in one. */
function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div role="treegrid" aria-label="Issues" aria-rowcount={4}>
      {children}
    </div>
  );
}

export const Variants: Story = {
  render: () => (
    <Grid>
      <GroupHeader
        name="In Progress"
        count={12}
        icon={<StatusIcon category="started" color="amber" />}
        collapsed={false}
        onToggle={() => {}}
        onAdd={() => {}}
        rowIndex={1}
      />
      <GroupHeader
        name="Done"
        count={1}
        icon={<StatusIcon category="completed" color="green" />}
        collapsed
        onToggle={() => {}}
        onAdd={() => {}}
        rowIndex={2}
      />
      <GroupHeader
        name="Backlog"
        count={0}
        icon={<StatusIcon category="backlog" />}
        collapsed={false}
        onToggle={() => {}}
        rowIndex={3}
      />
      <GroupHeader
        name="Todo"
        count={3}
        icon={<StatusIcon category="unstarted" />}
        collapsed={false}
        focused
        onToggle={() => {}}
        onAdd={() => {}}
        rowIndex={4}
      />
    </Grid>
  ),
};

export const Toggle: Story = {
  args: { onAdd: fn() },
  render: (args) => {
    function Host() {
      const [collapsed, setCollapsed] = useState(false);
      return (
        <Grid>
          <GroupHeader
            name="In Progress"
            count={12}
            icon={<StatusIcon category="started" color="amber" />}
            collapsed={collapsed}
            onToggle={() => setCollapsed((value) => !value)}
            onAdd={args.onAdd}
            rowIndex={1}
            tabIndex={0}
          />
        </Grid>
      );
    }
    return <Host />;
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const header = canvas.getByRole('row', { name: 'In Progress, 12 issues, expanded' });
    await userEvent.click(header);
    await expect(
      canvas.getByRole('row', { name: 'In Progress, 12 issues, collapsed' }),
    ).toHaveAttribute('aria-expanded', 'false');
    // The add button is not a toggle.
    await userEvent.click(canvas.getByRole('button', { name: 'Add issue to In Progress' }));
    await expect(args.onAdd).toHaveBeenCalledOnce();
    await expect(canvas.getByRole('row', { name: /collapsed/ })).toBeInTheDocument();
  },
};
