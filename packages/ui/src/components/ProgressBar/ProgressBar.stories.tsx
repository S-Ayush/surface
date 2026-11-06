import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Stack } from '../../stories/helpers.js';
import { ProgressBar } from './ProgressBar.js';

const meta = { title: 'Primitives/ProgressBar' } satisfies Meta;
export default meta;
type Story = StoryObj;

const Bars = () => (
  <Stack>
    <ProgressBar aria-label="Syncing workspace" value={0} />
    <ProgressBar aria-label="Importing issues" value={40} />
    <ProgressBar aria-label="Uploading" value={100} />
    <ProgressBar aria-label="Connecting" />
  </Stack>
);

export const Values: Story = { render: () => <Bars /> };

/** Exposes role="progressbar" with its value; indeterminate omits aria-valuenow. */
export const Accessibility: Story = {
  render: () => <Bars />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('progressbar', { name: 'Importing issues' })).toHaveAttribute(
      'aria-valuenow',
      '40',
    );
    await expect(canvas.getByRole('progressbar', { name: 'Connecting' })).not.toHaveAttribute(
      'aria-valuenow',
    );
  },
};
