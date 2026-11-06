import type { Meta, StoryObj } from '@storybook/react-vite';
import { Search } from 'lucide-react';
import { expect, userEvent, within } from 'storybook/test';
import { PSEUDO_STATES, Row, Stack, StateCell } from '../../stories/helpers.js';
import { Kbd } from '../Kbd/Kbd.js';
import { Input } from './Input.js';

const meta = { title: 'Primitives/Input' } satisfies Meta;
export default meta;
type Story = StoryObj;

export const Fields: Story = {
  render: () => (
    <Stack>
      <Input label="Team name" placeholder="Engineering" />
      <Input
        label="Team key"
        defaultValue="ENG"
        hint="2–5 letters. Used in issue IDs, like ENG-42."
      />
      <Input label="Team key" defaultValue="E" error="Team key must be 2–5 letters, like ENG" />
      <Input label="Workspace URL" defaultValue="surface.internal" disabled />
      <Input
        aria-label="Search"
        placeholder="Search"
        prefix={<Search aria-hidden />}
        suffix={<Kbd keys="Mod+K" />}
      />
    </Stack>
  ),
};

export const Sizes: Story = {
  render: () => (
    <Stack>
      <Input aria-label="Small" size="sm" placeholder="Small" />
      <Input aria-label="Medium" size="md" placeholder="Medium" />
      <Input aria-label="Large" size="lg" placeholder="Large" />
    </Stack>
  ),
};

export const States: Story = {
  parameters: PSEUDO_STATES,
  render: () => (
    <Row label="States">
      <StateCell id="default" label="Default">
        <Input aria-label="Default" placeholder="Title" />
      </StateCell>
      <StateCell id="hover" label="Hover">
        <Input aria-label="Hover" placeholder="Title" />
      </StateCell>
      <StateCell id="focused" label="Focused">
        <Input aria-label="Focused" placeholder="Title" autoFocus />
      </StateCell>
    </Row>
  ),
};

/** The label names the field; the error is its description; typing works. */
export const Keyboard: Story = {
  render: () => <Input label="Team key" error="Team key must be 2–5 letters, like ENG" />,
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByLabelText('Team key');
    await expect(input).toBeInvalid();
    await expect(input).toHaveAccessibleDescription('Team key must be 2–5 letters, like ENG');
    await userEvent.tab();
    await expect(input).toHaveFocus();
    await userEvent.keyboard('ENG');
    await expect(input).toHaveValue('ENG');
  },
};
