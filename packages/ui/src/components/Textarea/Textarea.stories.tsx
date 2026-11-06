import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Stack } from '../../stories/helpers.js';
import { Textarea } from './Textarea.js';

const meta = { title: 'Primitives/Textarea' } satisfies Meta;
export default meta;
type Story = StoryObj;

export const Fields: Story = {
  render: () => (
    <Stack>
      <Textarea label="Description" placeholder="What does this team work on?" />
      <Textarea
        label="Description"
        hint="Markdown is supported."
        defaultValue="Platform and sync."
      />
      <Textarea label="Reason" error="Add a reason so admins know why" />
      <Textarea label="Notes" defaultValue="Read only" disabled />
    </Stack>
  ),
};

/** Enter inserts a newline; Tab leaves the field. */
export const Keyboard: Story = {
  render: () => <Textarea label="Description" />,
  play: async ({ canvasElement }) => {
    const field = within(canvasElement).getByLabelText('Description');
    await userEvent.tab();
    await expect(field).toHaveFocus();
    await userEvent.keyboard('One{Enter}Two');
    await expect(field).toHaveValue('One\nTwo');
  },
};
