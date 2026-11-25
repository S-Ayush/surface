import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Row } from '../../stories/helpers.js';
import { SurfaceLockup, SurfaceMark } from './Brand.js';

const meta = { title: 'Brand/Mark and lockup' } satisfies Meta;
export default meta;
type Story = StoryObj;

/** The theme toolbar shows both themes; the wordmark and the mono mark follow the text colour. */
export const Mark: Story = {
  render: () => (
    <Row label="20, 32, 64 px, then mono">
      <SurfaceMark size={20} />
      <SurfaceMark size={32} />
      <SurfaceMark size={64} />
      <SurfaceMark size={32} mono />
    </Row>
  ),
};

export const Lockup: Story = {
  render: () => (
    <Row label="16, 24, 48 px tall">
      <SurfaceLockup height={16} />
      <SurfaceLockup height={24} />
      <SurfaceLockup height={48} />
    </Row>
  ),
};

/** Decorative by default; a title makes it an image with that name. */
export const Accessibility: Story = {
  render: () => <SurfaceLockup height={24} title="Surface" />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('img', { name: 'Surface' })).toBeVisible();
  },
};
