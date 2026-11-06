import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus } from 'lucide-react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '../Button/Button.js';
import { IconButton } from '../IconButton/IconButton.js';
import { Tooltip } from './Tooltip.js';

const meta = {
  title: 'Primitives/Tooltip',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

export const Open: Story = {
  render: () => (
    <Tooltip content="Create issue" shortcut="C" defaultOpen>
      <IconButton aria-label="Create issue" icon={<Plus />} />
    </Tooltip>
  ),
};

export const TextOnly: Story = {
  render: () => (
    <Tooltip content="Nov 6, 2026, 4:05 PM" side="bottom" defaultOpen>
      <Button variant="ghost">3m ago</Button>
    </Tooltip>
  ),
};

/** Keyboard focus opens the tooltip and Esc closes it, keeping focus on the trigger. */
export const Keyboard: Story = {
  render: () => (
    <Tooltip content="Create issue" shortcut="C">
      <IconButton aria-label="Create issue" icon={<Plus />} />
    </Tooltip>
  ),
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'Create issue' });
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.tab();
    await expect(trigger).toHaveFocus();
    await waitFor(() => expect(body.getByRole('tooltip')).toHaveTextContent('Create issue'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(body.queryByRole('tooltip')).toBeNull());
    await expect(trigger).toHaveFocus();
  },
};
