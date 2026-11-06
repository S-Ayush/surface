import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { PSEUDO_STATES, Row, Stack, StateCell } from '../../stories/helpers.js';
import { Switch } from './Switch.js';

const meta = { title: 'Primitives/Switch' } satisfies Meta;
export default meta;
type Story = StoryObj;

export const States: Story = {
  parameters: PSEUDO_STATES,
  render: () => (
    <Stack>
      <Row label="Values">
        <Switch label="Off" />
        <Switch label="On" defaultChecked />
        <Switch label="Disabled" disabled />
        <Switch label="Disabled, on" disabled defaultChecked />
      </Row>
      <Row label="Interaction">
        <StateCell id="focus" label="Focus visible">
          <Switch aria-label="Focus visible" defaultChecked />
        </StateCell>
      </Row>
    </Stack>
  ),
};

/** Space toggles and the state is exposed as aria-checked. */
export const Keyboard: Story = {
  render: () => <Switch label="Compact rows" />,
  play: async ({ canvasElement }) => {
    const toggle = within(canvasElement).getByRole('switch', { name: 'Compact rows' });
    await userEvent.tab();
    await expect(toggle).toHaveFocus();
    await userEvent.keyboard(' ');
    await expect(toggle).toBeChecked();
    await userEvent.keyboard('{Enter}');
    await expect(toggle).not.toBeChecked();
  },
};
