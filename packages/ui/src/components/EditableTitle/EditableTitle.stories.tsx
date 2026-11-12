import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Row, Stack } from '../../stories/helpers.js';
import { EditableTitle } from './EditableTitle.js';

const meta = { title: 'Primitives/EditableTitle' } satisfies Meta;
export default meta;
type Args = { onSave: (title: string) => void };
type Story = StoryObj<Args>;

function Host({
  onSave,
  startEditing = false,
}: {
  onSave: (title: string) => void;
  startEditing?: boolean;
}) {
  const [title, setTitle] = useState('Fix login redirect');
  const [editing, setEditing] = useState(startEditing);
  return (
    <EditableTitle
      value={title}
      editing={editing}
      onEditingChange={setEditing}
      onSave={(next) => {
        setTitle(next);
        onSave(next);
      }}
    />
  );
}

export const States: Story = {
  render: () => (
    <Stack>
      <Row label="Display">
        <EditableTitle
          value="Fix login redirect"
          editing={false}
          onEditingChange={() => {}}
          onSave={() => {}}
        />
      </Row>
      <Row label="Editing">
        <Host onSave={() => {}} startEditing />
      </Row>
      <Row label="Read only (archived or deleted)">
        <EditableTitle
          value="Fix login redirect"
          editing={false}
          readOnly
          onEditingChange={() => {}}
          onSave={() => {}}
        />
      </Row>
    </Stack>
  ),
};

export const SaveOnEnter: Story = {
  args: { onSave: fn() },
  render: (args) => <Host onSave={args.onSave} />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Fix login redirect' }));
    const field = canvas.getByRole('textbox', { name: 'Issue title' });
    await expect(field).toHaveFocus();
    await userEvent.type(field, ' loop{Enter}');
    await expect(args.onSave).toHaveBeenCalledOnce();
    await expect(args.onSave).toHaveBeenCalledWith('Fix login redirect loop');
    // Back to the display form, with focus on it.
    await expect(canvas.getByRole('button', { name: 'Fix login redirect loop' })).toHaveFocus();
  },
};

export const CancelOnEscape: Story = {
  args: { onSave: fn() },
  render: (args) => <Host onSave={args.onSave} />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Fix login redirect' }));
    await userEvent.type(canvas.getByRole('textbox'), ' loop{Escape}');
    await expect(args.onSave).not.toHaveBeenCalled();
    await expect(canvas.getByRole('button', { name: 'Fix login redirect' })).toHaveFocus();
  },
};

export const SaveOnBlur: Story = {
  args: { onSave: fn() },
  render: (args) => (
    <div>
      <Host onSave={args.onSave} />
      <button type="button">Elsewhere</button>
    </div>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Fix login redirect' }));
    await userEvent.type(canvas.getByRole('textbox'), '!');
    await userEvent.click(canvas.getByRole('button', { name: 'Elsewhere' }));
    await expect(args.onSave).toHaveBeenCalledOnce();
    await expect(args.onSave).toHaveBeenCalledWith('Fix login redirect!');
  },
};

/** An empty or unchanged title just closes: a title is required (1–255 characters). */
export const EmptyOrUnchanged: Story = {
  args: { onSave: fn() },
  render: (args) => <Host onSave={args.onSave} />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Fix login redirect' }));
    await userEvent.clear(canvas.getByRole('textbox'));
    await userEvent.keyboard('{Enter}');
    await expect(args.onSave).not.toHaveBeenCalled();
    await expect(canvas.getByRole('button', { name: 'Fix login redirect' })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Fix login redirect' }));
    await userEvent.keyboard('{Enter}');
    await expect(args.onSave).not.toHaveBeenCalled();
  },
};
