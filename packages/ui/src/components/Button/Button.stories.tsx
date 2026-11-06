import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus, Trash2 } from 'lucide-react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { PSEUDO_STATES, Row, Stack, StateCell } from '../../stories/helpers.js';
import { Button, type ButtonVariant } from './Button.js';

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger'];

const meta = {
  title: 'Primitives/Button',
  component: Button,
  args: { children: 'Create issue', onClick: fn() },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = { args: { variant: 'primary' } };

export const Variants: Story = {
  render: () => (
    <Stack>
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <Row key={size} label={`Size ${size}`}>
          {VARIANTS.map((variant) => (
            <Button key={variant} variant={variant} size={size}>
              {variant === 'danger' ? 'Delete team' : 'Create issue'}
            </Button>
          ))}
        </Row>
      ))}
      <Row label="Icon and shortcut">
        <Button variant="primary" icon={<Plus />} shortcut="C">
          Create issue
        </Button>
        <Button icon={<Plus />} shortcut="Mod+Enter">
          Create
        </Button>
        <Button variant="danger" icon={<Trash2 />}>
          Delete
        </Button>
      </Row>
    </Stack>
  ),
};

export const States: Story = {
  parameters: PSEUDO_STATES,
  render: () => (
    <Stack>
      {VARIANTS.map((variant) => (
        <Row key={variant} label={variant}>
          <StateCell id="default" label="Default">
            <Button variant={variant}>Save changes</Button>
          </StateCell>
          <StateCell id="hover" label="Hover">
            <Button variant={variant}>Save changes</Button>
          </StateCell>
          <StateCell id="active" label="Active">
            <Button variant={variant}>Save changes</Button>
          </StateCell>
          <StateCell id="focus" label="Focus visible">
            <Button variant={variant}>Save changes</Button>
          </StateCell>
          <StateCell id="disabled" label="Disabled">
            <Button variant={variant} disabled>
              Save changes
            </Button>
          </StateCell>
          <StateCell id="loading" label="Loading">
            <Button variant={variant} loading>
              Save changes
            </Button>
          </StateCell>
        </Row>
      ))}
    </Stack>
  ),
};

/** Enter and Space activate; a loading button stays focusable but ignores activation. */
export const Keyboard: Story = {
  render: (args) => (
    <Row label="Keyboard">
      <Button {...args} shortcut="Mod+Enter">
        Create issue
      </Button>
      <Button {...args} loading>
        Saving
      </Button>
    </Row>
  ),
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    // Exact name: the shortcut hint is not part of it; it is exposed as aria-keyshortcuts.
    const create = canvas.getByRole('button', { name: 'Create issue' });
    await expect(create).toHaveAccessibleName('Create issue');
    await expect(create).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter');
    await expect(create).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    await expect(args.onClick).toHaveBeenCalledTimes(2);

    await userEvent.tab();
    const saving = canvas.getByRole('button', { name: 'Saving' });
    await expect(saving).toHaveFocus();
    await expect(saving).toHaveAttribute('aria-busy', 'true');
    await userEvent.keyboard('{Enter}');
    await expect(args.onClick).toHaveBeenCalledTimes(2);
  },
};
