import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Row, Stack } from '../../stories/helpers.js';
import { SAMPLE_LABELS } from '../../stories/issue-data.js';
import { LabelChip } from './LabelChip.js';

const meta = { title: 'Primitives/LabelChip' } satisfies Meta;
export default meta;
type Args = { onRemove: () => void };
type Story = StoryObj<Args>;

export const Variants: Story = {
  render: () => (
    <Stack>
      <Row label="Read only">
        {SAMPLE_LABELS.map((label) => (
          <LabelChip key={label.id} name={label.name} color={label.color} />
        ))}
      </Row>
      <Row label="Removable (edit mode)">
        {SAMPLE_LABELS.map((label) => (
          <LabelChip key={label.id} name={label.name} color={label.color} onRemove={() => {}} />
        ))}
      </Row>
      <Row label="Long name in a narrow box">
        <div style={{ width: 120 }}>
          <LabelChip name="A very long label name that must be cut" color="teal" />
        </div>
      </Row>
    </Stack>
  ),
};

export const Remove: Story = {
  args: { onRemove: fn() },
  render: (args) => <LabelChip name="Bug" color="red" onRemove={args.onRemove} />,
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Remove label Bug' }));
    await expect(args.onRemove).toHaveBeenCalledOnce();
  },
};
