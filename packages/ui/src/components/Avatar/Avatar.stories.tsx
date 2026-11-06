import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { Row, Stack } from '../../stories/helpers.js';
import { Avatar, AvatarGroup } from './Avatar.js';

const meta = { title: 'Primitives/Avatar' } satisfies Meta;
export default meta;
type Story = StoryObj;

const PEOPLE = [
  'Ada Lovelace',
  'Grace Hopper',
  'Alan Turing',
  'Katherine Johnson',
  'Linus',
  'Margaret Hamilton',
];

export const Sizes: Story = {
  render: () => (
    <Stack>
      {([16, 20, 24, 32] as const).map((size) => (
        <Row key={size} label={`${size} px`}>
          {PEOPLE.map((name) => (
            <Avatar key={name} name={name} size={size} />
          ))}
          <Avatar name="Ada Lovelace" size={size} online />
        </Row>
      ))}
    </Stack>
  ),
};

export const Group: Story = {
  render: () => (
    <Stack>
      <AvatarGroup aria-label="Assignees" max={3}>
        {PEOPLE.map((name) => (
          <Avatar key={name} name={name} />
        ))}
      </AvatarGroup>
      <AvatarGroup aria-label="Reviewers" size={32} max={4}>
        {PEOPLE.slice(0, 3).map((name) => (
          <Avatar key={name} name={name} />
        ))}
      </AvatarGroup>
    </Stack>
  ),
};

/** The avatar is an image named after the person; the overflow says how many are hidden. */
export const Accessibility: Story = {
  render: () => (
    <AvatarGroup aria-label="Assignees" max={2}>
      <Avatar name="Ada Lovelace" online />
      <Avatar name="Grace Hopper" />
      <Avatar name="Alan Turing" />
      <Avatar name="Linus" />
    </AvatarGroup>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('img', { name: 'Ada Lovelace (online)' })).toBeVisible();
    await expect(canvas.getByRole('img', { name: 'Grace Hopper' })).toBeVisible();
    await expect(canvas.getByRole('img', { name: '2 more' })).toHaveTextContent('+2');
  },
};
