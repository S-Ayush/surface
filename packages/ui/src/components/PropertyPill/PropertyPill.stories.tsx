import type { Meta, StoryObj } from '@storybook/react-vite';
import { CircleUser } from 'lucide-react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { PSEUDO_STATES, Row, Stack, StateCell } from '../../stories/helpers.js';
import { PriorityIcon } from '../PriorityIcon/PriorityIcon.js';
import { StatusIcon } from '../StatusIcon/StatusIcon.js';
import { PropertyPill } from './PropertyPill.js';

const meta = { title: 'Primitives/PropertyPill' } satisfies Meta;
export default meta;
type Args = { onClick: () => void };
type Story = StoryObj<Args>;

export const Variants: Story = {
  render: () => (
    <Stack>
      <Row label="With a value">
        <PropertyPill
          property="Status"
          value="In Progress"
          icon={<StatusIcon category="started" color="amber" />}
        />
        <PropertyPill property="Priority" value="High" icon={<PriorityIcon priority={2} />} />
        <PropertyPill property="Estimate" value="3" />
      </Row>
      <Row label="Empty: the placeholder shows on hover or focus only">
        <PropertyPill property="Assignee" value={null} icon={<CircleUser />} />
      </Row>
      <Row label="Icon only (rows)">
        <PropertyPill
          property="Status"
          value="Done"
          iconOnly
          icon={<StatusIcon category="completed" color="green" />}
        />
      </Row>
      <Row label="Read only">
        <PropertyPill
          property="Status"
          value="Done"
          readOnly
          icon={<StatusIcon category="completed" color="green" />}
        />
      </Row>
    </Stack>
  ),
};

export const States: Story = {
  parameters: PSEUDO_STATES,
  render: () => (
    <Row label="Rest, hover, focus">
      <StateCell id="rest" label="Rest">
        <PropertyPill property="Priority" value="Urgent" icon={<PriorityIcon priority={1} />} />
      </StateCell>
      <StateCell id="hover" label="Hover">
        <PropertyPill property="Priority" value="Urgent" icon={<PriorityIcon priority={1} />} />
      </StateCell>
      <StateCell id="focus" label="Focus">
        <PropertyPill property="Priority" value="Urgent" icon={<PriorityIcon priority={1} />} />
      </StateCell>
    </Row>
  ),
};

export const Click: Story = {
  args: { onClick: fn() },
  render: (args) => (
    <PropertyPill
      property="Status"
      value="Todo"
      icon={<StatusIcon category="unstarted" />}
      onClick={args.onClick}
    />
  ),
  play: async ({ canvasElement, args }) => {
    const pill = within(canvasElement).getByRole('button', { name: 'Status: Todo, change' });
    await userEvent.tab();
    await expect(pill).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onClick).toHaveBeenCalledOnce();
  },
};
