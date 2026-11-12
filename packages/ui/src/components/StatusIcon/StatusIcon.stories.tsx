import type { Meta, StoryObj } from '@storybook/react-vite';
import { COLOR_HUES } from '@surface/domain';
import { Row, Stack } from '../../stories/helpers.js';
import { CATEGORIES } from '../../stories/issue-data.js';
import { StatusIcon } from './StatusIcon.js';

const meta = { title: 'Primitives/StatusIcon' } satisfies Meta;
export default meta;
type Story = StoryObj;

/** One shape per category; the colour is the status's own hue. */
export const Categories: Story = {
  render: () => (
    <Stack>
      <Row label="Categories">
        {CATEGORIES.map((category) => (
          <StatusIcon key={category} category={category} color="blue" label={category} />
        ))}
      </Row>
      <Row label="Hues, started">
        {COLOR_HUES.map((hue) => (
          <StatusIcon key={hue} category="started" color={hue} />
        ))}
      </Row>
      <Row label="Hues, completed">
        {COLOR_HUES.map((hue) => (
          <StatusIcon key={hue} category="completed" color={hue} />
        ))}
      </Row>
    </Stack>
  ),
};
