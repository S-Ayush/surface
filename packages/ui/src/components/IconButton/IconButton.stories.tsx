import type { Meta, StoryObj } from '@storybook/react-vite';
import { Ellipsis, Plus, X } from 'lucide-react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { PSEUDO_STATES, Row, Stack, StateCell } from '../../stories/helpers.js';
import { Tooltip } from '../Tooltip/Tooltip.js';
import { IconButton } from './IconButton.js';

const meta = {
  title: 'Primitives/IconButton',
  component: IconButton,
  args: { 'aria-label': 'More actions', icon: <Ellipsis />, onClick: fn() },
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {
  render: () => (
    <Stack>
      {(['ghost', 'secondary'] as const).map((variant) => (
        <Row key={variant} label={variant}>
          {(['sm', 'md', 'lg'] as const).map((size) => (
            <IconButton
              key={size}
              variant={variant}
              size={size}
              aria-label="Create issue"
              icon={<Plus />}
            />
          ))}
          <IconButton variant={variant} aria-label="Close" icon={<X />} disabled />
        </Row>
      ))}
    </Stack>
  ),
};

export const States: Story = {
  parameters: PSEUDO_STATES,
  render: () => (
    <Row label="ghost">
      {[
        ['default', 'Default'],
        ['hover', 'Hover'],
        ['active', 'Active'],
        ['focus', 'Focus visible'],
      ].map(([id = '', label = '']) => (
        <StateCell key={id} id={id} label={label}>
          <IconButton aria-label="More actions" icon={<Ellipsis />} />
        </StateCell>
      ))}
    </Row>
  ),
};

/** The accessible name comes from aria-label; Enter activates. */
export const Keyboard: Story = {
  render: (args) => (
    <Tooltip content="More actions" shortcut="Mod+.">
      <IconButton {...args} />
    </Tooltip>
  ),
  play: async ({ canvasElement, args }) => {
    await userEvent.tab();
    const button = within(canvasElement).getByRole('button', { name: 'More actions' });
    await expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onClick).toHaveBeenCalledOnce();
  },
};
