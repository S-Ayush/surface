import type { Meta, StoryObj } from '@storybook/react-vite';
import { Columns3, List } from 'lucide-react';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Stack } from '../../stories/helpers.js';
import { SegmentedControl } from './SegmentedControl.js';

/**
 * Radix moves focus on the next tick and selects only while the arrow key is still down, as in a
 * real key press; user-event would release it at once. Hold the key until focus has moved.
 */
async function press(key: string) {
  const before = document.activeElement;
  await userEvent.keyboard(key.replace('}', '>}'));
  await waitFor(() => expect(document.activeElement).not.toBe(before));
  await userEvent.keyboard(key.replace('{', '{/'));
}

const meta = { title: 'Primitives/SegmentedControl' } satisfies Meta;
export default meta;
type Story = StoryObj;

function Layout({ size }: { size?: 'sm' | 'md' }) {
  const [value, setValue] = useState<'list' | 'board'>('list');
  return (
    <SegmentedControl
      aria-label="Layout"
      size={size}
      value={value}
      onValueChange={setValue}
      options={[
        { value: 'list', label: 'List', icon: <List /> },
        { value: 'board', label: 'Board', icon: <Columns3 /> },
      ]}
    />
  );
}

function Density() {
  const [value, setValue] = useState<'comfortable' | 'compact' | 'auto'>('comfortable');
  return (
    <SegmentedControl
      aria-label="Density"
      value={value}
      onValueChange={setValue}
      options={[
        { value: 'comfortable', label: 'Comfortable' },
        { value: 'compact', label: 'Compact' },
        { value: 'auto', label: 'Auto', disabled: true },
      ]}
    />
  );
}

export const Default: Story = {
  render: () => (
    <Stack>
      <Layout />
      <Layout size="sm" />
      <Density />
    </Stack>
  ),
};

/** Arrow keys move the selection and wrap around. */
export const Keyboard: Story = {
  render: () => <Layout />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('radio', { name: 'List' })).toHaveFocus();
    await press('{ArrowRight}');
    await waitFor(() => expect(canvas.getByRole('radio', { name: 'Board' })).toBeChecked());
    await press('{ArrowRight}');
    await waitFor(() => expect(canvas.getByRole('radio', { name: 'List' })).toBeChecked());
  },
};
