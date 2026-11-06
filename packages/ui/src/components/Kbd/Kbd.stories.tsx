import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { PlatformProvider } from '../../platform.js';
import { Row, Stack } from '../../stories/helpers.js';
import { Kbd } from './Kbd.js';

const meta = { title: 'Primitives/Kbd' } satisfies Meta;
export default meta;
type Story = StoryObj;

const EXAMPLES = ['Mod+K', 'Alt+Shift+T', 'Mod+Enter', '?', 'Escape', ['G', 'S']] as const;

export const Platforms: Story = {
  render: () => (
    <Stack>
      {(['mac', 'other'] as const).map((platform) => (
        <PlatformProvider key={platform} platform={platform}>
          <Row label={platform === 'mac' ? 'macOS' : 'Windows and Linux'}>
            {EXAMPLES.map((keys) => (
              <Kbd key={String(keys)} keys={keys} />
            ))}
          </Row>
        </PlatformProvider>
      ))}
    </Stack>
  ),
};

/** Screen readers get the spoken form, not the symbols. */
export const SpokenForm: Story = {
  render: () => (
    <PlatformProvider platform="mac">
      <p>
        Open the command menu with <Kbd keys="Mod+K" />, or go to settings with{' '}
        <Kbd keys={['G', 'S']} />.
      </p>
    </PlatformProvider>
  ),
  play: async ({ canvasElement }) => {
    const text = within(canvasElement).getByText(/Open the command menu/);
    await expect(text).toHaveTextContent('Command K');
    await expect(text).toHaveTextContent('G then S');
  },
};
