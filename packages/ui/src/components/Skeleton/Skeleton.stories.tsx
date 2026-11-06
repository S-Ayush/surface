import type { Meta, StoryObj } from '@storybook/react-vite';
import { Row, Stack } from '../../stories/helpers.js';
import { Skeleton } from './Skeleton.js';

const meta = { title: 'Primitives/Skeleton' } satisfies Meta;
export default meta;
type Story = StoryObj;

/** Shapes appear after 150 ms so fast loads never flash; the loading region carries aria-busy. */
export const Shapes: Story = {
  render: () => (
    <div aria-busy="true" aria-label="Loading comments" role="region">
      <Stack>
        <Row label="Text">
          <Skeleton width="60%" />
        </Row>
        <Row label="Avatar and text">
          <Skeleton shape="circle" />
          <Skeleton width="40%" />
        </Row>
        <Skeleton shape="row" />
        <Skeleton shape="row" />
      </Stack>
    </div>
  ),
};
