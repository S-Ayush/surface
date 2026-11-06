import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PSEUDO_STATES, Row, Stack, StateCell } from '../../stories/helpers.js';
import { Checkbox } from './Checkbox.js';

const meta = { title: 'Primitives/Checkbox' } satisfies Meta;
export default meta;
type Story = StoryObj;

export const States: Story = {
  parameters: PSEUDO_STATES,
  render: () => (
    <Stack>
      <Row label="Values">
        <Checkbox label="Unchecked" />
        <Checkbox label="Checked" defaultChecked />
        <Checkbox label="Some selected" checked="indeterminate" />
        <Checkbox label="Disabled" disabled />
        <Checkbox label="Disabled, checked" disabled defaultChecked />
      </Row>
      <Row label="Interaction">
        <StateCell id="hover" label="Hover">
          <Checkbox aria-label="Hover" />
        </StateCell>
        <StateCell id="focus" label="Focus visible">
          <Checkbox aria-label="Focus visible" defaultChecked />
        </StateCell>
      </Row>
    </Stack>
  ),
};

/** Space toggles; the visible label names the checkbox. */
export const Keyboard: Story = {
  render: () => <Checkbox label="Create more" />,
  play: async ({ canvasElement }) => {
    const box = within(canvasElement).getByRole('checkbox', { name: 'Create more' });
    await userEvent.tab();
    await expect(box).toHaveFocus();
    await expect(box).not.toBeChecked();
    await userEvent.keyboard(' ');
    await expect(box).toBeChecked();
    await userEvent.keyboard(' ');
    await expect(box).not.toBeChecked();
  },
};
