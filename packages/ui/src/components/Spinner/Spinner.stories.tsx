import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Row } from '../../stories/helpers.js';
import { Spinner } from './Spinner.js';

const meta = { title: 'Primitives/Spinner' } satisfies Meta;
export default meta;
type Story = StoryObj;

export const Sizes: Story = {
  render: () => (
    <Row label="sm, md, lg">
      <Spinner size="sm" />
      <Spinner size="md" />
      <Spinner size="lg" />
    </Row>
  ),
};

/** A status named "Loading" unless the label is overridden. */
export const Accessibility: Story = {
  render: () => <Spinner label="Sending invite" />,
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('status', { name: 'Sending invite' }),
    ).toBeVisible();
  },
};
