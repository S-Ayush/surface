import type { Meta, StoryObj } from '@storybook/react-vite';
import { Row } from '../../stories/helpers.js';
import { Badge } from './Badge.js';

const meta = { title: 'Primitives/Badge' } satisfies Meta;
export default meta;
type Story = StoryObj;

export const Variants: Story = {
  render: () => (
    <Row label="Neutral and accent">
      <Badge count={3} />
      <Badge count={42} />
      <Badge count={1200} />
      <Badge variant="accent" count={7} />
      <Badge variant="accent">New</Badge>
    </Row>
  ),
};
