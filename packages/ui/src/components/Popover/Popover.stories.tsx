import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { overlayManager } from '../../overlays/manager.js';
import { Stack } from '../../stories/helpers.js';
import { Button } from '../Button/Button.js';
import { Switch } from '../Switch/Switch.js';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from './Popover.js';

const meta = { title: 'Overlays/Popover' } satisfies Meta;
export default meta;
type Story = StoryObj;

function DisplayOptions({ defaultOpen }: { defaultOpen?: boolean }) {
  return (
    <Popover defaultOpen={defaultOpen}>
      <PopoverTrigger>
        <Button icon={<SlidersHorizontal />}>Display</Button>
      </PopoverTrigger>
      <PopoverContent aria-label="Display options">
        <Stack>
          <Switch label="Show empty groups" />
          <Switch label="Compact rows" defaultChecked />
        </Stack>
      </PopoverContent>
    </Popover>
  );
}

export const Open: Story = {
  render: () => <DisplayOptions defaultOpen />,
};

/**
 * Enter opens and moves focus inside; Esc closes and returns focus to the trigger; an outside
 * click closes without stealing focus back. The open popover is a layer in the overlay manager.
 */
export const Keyboard: Story = {
  render: () => (
    <Stack>
      <DisplayOptions />
      <Button>Elsewhere</Button>
    </Stack>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Display' });
    await userEvent.tab();
    await expect(trigger).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Display options' });
    await waitFor(() =>
      expect(within(dialog).getByRole('switch', { name: 'Show empty groups' })).toHaveFocus(),
    );
    await expect(overlayManager.topLayer()?.kind).toBe('popover');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    await expect(overlayManager.topLayer()).toBeUndefined();

    await userEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'Display options' });
    const elsewhere = canvas.getByRole('button', { name: 'Elsewhere' });
    await userEvent.click(elsewhere);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(elsewhere).toHaveFocus());
  },
};

/** Opened by a shortcut on a focused row: anchored to the row, with no trigger (pickers). */
function AnchoredPicker() {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor>
        <Button onClick={() => setOpen(true)}>ENG-1 Fix login redirect</Button>
      </PopoverAnchor>
      <PopoverContent aria-label="Set priority">
        <Button>Urgent</Button>
      </PopoverContent>
    </Popover>
  );
}

/** Without a trigger, Esc returns focus to what was focused when it opened, not to <body>. */
export const AnchorOnly: Story = {
  render: () => <AnchoredPicker />,
  play: async ({ canvasElement }) => {
    const row = within(canvasElement).getByRole('button', { name: 'ENG-1 Fix login redirect' });
    row.focus();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: 'Set priority' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(row).toHaveFocus());
  },
};
