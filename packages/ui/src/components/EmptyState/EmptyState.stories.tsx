import type { Meta, StoryObj } from '@storybook/react-vite';
import { CircleDashed, Plus } from 'lucide-react';
import { Button } from '../Button/Button.js';
import { EmptyState } from './EmptyState.js';

const meta = { title: 'Primitives/EmptyState' } satisfies Meta;
export default meta;
type Story = StoryObj;

export const WithAction: Story = {
  render: () => (
    <EmptyState
      icon={<CircleDashed />}
      title="No issues yet"
      description="Issues you create or are assigned appear here."
      action={
        <Button variant="primary" icon={<Plus />} shortcut="C">
          Create issue
        </Button>
      }
    />
  ),
};

export const TextOnly: Story = {
  render: () => <EmptyState icon={<CircleDashed />} title="Issues arrive in M1" />,
};
