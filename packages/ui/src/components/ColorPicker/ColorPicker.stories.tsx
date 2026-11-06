import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { LabelHue } from '../../tokens.gen.js';
import { ColorPicker } from './ColorPicker.js';

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

const meta = { title: 'Primitives/ColorPicker' } satisfies Meta;
export default meta;
type Story = StoryObj;

function TeamColor({ initial }: { initial?: LabelHue }) {
  const [hue, setHue] = useState<LabelHue | undefined>(initial);
  return <ColorPicker aria-label="Team color" value={hue} onValueChange={setHue} />;
}

export const Default: Story = { render: () => <TeamColor initial="teal" /> };

/** Arrow keys move through the palette and select; each swatch is named by its hue. */
export const Keyboard: Story = {
  render: () => <TeamColor initial="red" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('radio', { name: 'Red' })).toHaveFocus();
    await press('{ArrowRight}');
    await waitFor(() => expect(canvas.getByRole('radio', { name: 'Orange' })).toBeChecked());
    await press('{ArrowLeft}');
    await waitFor(() => expect(canvas.getByRole('radio', { name: 'Red' })).toBeChecked());
    await press('{ArrowLeft}');
    await waitFor(() => expect(canvas.getByRole('radio', { name: 'Gray' })).toBeChecked());
  },
};
