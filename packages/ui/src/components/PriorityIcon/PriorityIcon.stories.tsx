import type { Meta, StoryObj } from '@storybook/react-vite';
import { Row } from '../../stories/helpers.js';
import { PRIORITY_VALUES } from '../../stories/issue-data.js';
import { PriorityIcon } from './PriorityIcon.js';

const meta = { title: 'Primitives/PriorityIcon' } satisfies Meta;
export default meta;
type Story = StoryObj;

export const Priorities: Story = {
  render: () => (
    <Row label="No priority, Urgent, High, Medium, Low">
      {PRIORITY_VALUES.map((priority) => (
        <PriorityIcon key={priority} priority={priority} label />
      ))}
    </Row>
  ),
};
