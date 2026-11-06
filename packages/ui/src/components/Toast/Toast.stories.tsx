import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { overlayManager, toast } from '../../overlays/manager.js';
import { Stack } from '../../stories/helpers.js';
import { Button } from '../Button/Button.js';
import { Dialog } from '../Dialog/Dialog.js';

// Toasts render in <OverlayProvider>'s region (added by the Storybook decorator), bottom right.
const meta = { title: 'Overlays/Toast' } satisfies Meta;
export default meta;
type Story = StoryObj;

/** Stories keep toasts until dismissed, so tests and snapshots never race the 5 s timer. */
const STAY = Infinity;

export const Tones: Story = {
  beforeEach: () => {
    toast({ message: 'Copied link to ENG-12', duration: STAY });
    toast({ message: 'Issue created', tone: 'success', duration: STAY });
    toast({
      message: 'Issue moved to trash',
      action: { label: 'Undo', onAction: () => {} },
      duration: STAY,
    });
  },
  render: () => <p>Toasts stack in the bottom-right corner.</p>,
};

function Notifier() {
  const count = useRef(0);
  return (
    <Button onClick={() => toast({ message: `Notification ${++count.current}`, duration: STAY })}>
      Notify
    </Button>
  );
}

/** Three at a time, the rest wait their turn; each one is announced politely. */
export const Queue: Story = {
  render: () => <Notifier />,
  play: async ({ canvasElement }) => {
    const notify = within(canvasElement).getByRole('button', { name: 'Notify' });
    for (let i = 0; i < 4; i++) await userEvent.click(notify);
    await screen.findByText('Notification 3');
    await waitFor(() => expect(screen.queryByText('Notification 4')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(
        [...document.querySelectorAll('[role="status"][aria-live="polite"]')].some((el) =>
          el.textContent?.includes('Notification 1'),
        ),
      ).toBe(true),
    );

    const first = screen.getByText('Notification 1').closest('li');
    if (first === null) throw new Error('Toast not found');
    await userEvent.click(within(first).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText('Notification 1')).not.toBeInTheDocument());
    await screen.findByText('Notification 4');
  },
};

const onUndo = fn();

function Trash() {
  return (
    <Button
      onClick={() =>
        toast({
          message: 'Issue moved to trash',
          action: { label: 'Undo', onAction: onUndo },
          duration: STAY,
        })
      }
    >
      Delete
    </Button>
  );
}

/** Esc on the page is left for the page (S5 clears the selection); the action runs and closes. */
export const Action: Story = {
  render: () => <Trash />,
  play: async ({ canvasElement }) => {
    onUndo.mockClear();
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Delete' }));
    await screen.findByText('Issue moved to trash');
    await userEvent.keyboard('{Escape}');
    await expect(screen.getByText('Issue moved to trash')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await expect(onUndo).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('Issue moved to trash')).not.toBeInTheDocument());
  },
};

function SaveInDialog() {
  const [open, setOpen] = useState(false);
  return (
    <Stack>
      <Button onClick={() => setOpen(true)}>Edit view</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="sm"
        title="Edit view"
        footer={
          <Button onClick={() => toast({ message: 'View saved', duration: STAY })}>Save</Button>
        }
      />
    </Stack>
  );
}

/**
 * A toast raised while a dialog is open waits until it closes, so it never sits above the dialog
 * and swallows its Esc.
 */
export const HeldWhileDialogOpen: Story = {
  render: () => <SaveInDialog />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Edit view' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit view' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await expect(overlayManager.getSnapshot().queuedToasts.map((t) => t.message)).toEqual([
      'View saved',
    ]);
    await waitFor(() => expect(screen.queryByText('View saved')).not.toBeInTheDocument());

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await screen.findByText('View saved');
  },
};

/**
 * Esc on the page is the page's (S5): a visible toast neither takes it nor marks it handled, and
 * the manager says it was not for an overlay. Esc with a dialog open is for the overlay.
 */
export const PageEscape: Story = {
  render: () => <SaveInDialog />,
  play: async ({ canvasElement }) => {
    const seen: { prevented: boolean; overlay: boolean }[] = [];
    const listen = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        seen.push({
          prevented: event.defaultPrevented,
          overlay: overlayManager.isOverlayEscape(event),
        });
      }
    };
    document.addEventListener('keydown', listen);
    try {
      toast({ message: 'Issue moved to trash', duration: STAY });
      await screen.findByText('Issue moved to trash');
      within(canvasElement).getByRole('button', { name: 'Edit view' }).focus();
      await userEvent.keyboard('{Escape}');
      await expect(screen.getByText('Issue moved to trash')).toBeInTheDocument();
      await expect(seen.at(-1)).toEqual({ prevented: false, overlay: false });

      await userEvent.keyboard('{Enter}');
      await screen.findByRole('dialog', { name: 'Edit view' });
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await expect(seen.at(-1)?.overlay).toBe(true);
    } finally {
      document.removeEventListener('keydown', listen);
    }
  },
};

/** Esc in a focused toast closes that toast, even when it is not the newest. */
export const EscapeInToast: Story = {
  beforeEach: () => {
    for (const n of [1, 2, 3]) toast({ message: `Notification ${n}`, duration: STAY });
  },
  render: () => <p>Three toasts</p>,
  play: async () => {
    const first = (await screen.findByText('Notification 1')).closest('li');
    if (first === null) throw new Error('Toast not found');
    within(first).getByRole('button', { name: 'Dismiss' }).focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('Notification 1')).not.toBeInTheDocument());
    await expect(screen.getByText('Notification 2')).toBeInTheDocument();
    await expect(screen.getByText('Notification 3')).toBeInTheDocument();
  },
};

/** Updating a toast in place (same id) announces the new text again. */
export const UpdateInPlace: Story = {
  render: () => <p>Sync status</p>,
  play: async () => {
    toast({ id: 'sync', message: 'Syncing 3 changes', duration: STAY });
    await screen.findByText('Syncing 3 changes');
    toast({ id: 'sync', message: 'Syncing 1 change', duration: STAY });
    await waitFor(() =>
      expect(
        [...document.querySelectorAll('[role="status"][aria-live="polite"]')].some((el) =>
          el.textContent?.includes('Syncing 1 change'),
        ),
      ).toBe(true),
    );
  },
};
