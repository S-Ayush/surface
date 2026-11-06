import type { Meta, StoryObj } from '@storybook/react-vite';
import { Ellipsis } from 'lucide-react';
import { useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { overlayManager } from '../../overlays/manager.js';
import { isOnTop, Stack } from '../../stories/helpers.js';
import { Button } from '../Button/Button.js';
import { IconButton } from '../IconButton/IconButton.js';
import { Input } from '../Input/Input.js';
import { Menu } from '../Menu/Menu.js';
import { Textarea } from '../Textarea/Textarea.js';
import { Dialog, DialogClose } from './Dialog.js';
import styles from './Dialog.stories.module.css';

const meta = { title: 'Overlays/Dialog', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj;

function CreateIssue({
  open,
  onOpenChange,
  withMenu = false,
  menuOpen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  withMenu?: boolean;
  /** Static stories: keep the menu inside the dialog open. */
  menuOpen?: boolean;
}) {
  const [title, setTitle] = useState('');
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create issue"
      dirty={title !== ''}
      footer={
        <>
          <DialogClose>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" shortcut="Mod+Enter">
            Create issue
          </Button>
        </>
      }
    >
      <Stack>
        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Textarea label="Description" rows={3} />
        {withMenu && (
          <Menu
            // Controlled for the static story: the dialog's autofocus would close an uncontrolled
            // menu that opened with it.
            {...(menuOpen ? { open: true } : {})}
            trigger={
              <IconButton aria-label="More options" icon={<Ellipsis />} variant="secondary" />
            }
            items={[{ type: 'item', label: 'Use template', onSelect: () => {} }]}
          />
        )}
      </Stack>
    </Dialog>
  );
}

/** Opened by a plain button (as a shortcut or the command menu would), not a Radix trigger. */
function Opener({ withMenu }: { withMenu?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.page}>
      <Button onClick={() => setOpen(true)}>New issue</Button>
      <CreateIssue open={open} onOpenChange={setOpen} withMenu={withMenu} />
    </div>
  );
}

export const Medium: Story = {
  render: () => <CreateIssue open onOpenChange={() => {}} />,
};

/** A menu (or popover) opened inside a dialog stacks above it. */
export const MenuInDialog: Story = {
  name: 'Menu in dialog',
  render: () => <CreateIssue open onOpenChange={() => {}} withMenu menuOpen />,
};

export const Small: Story = {
  render: () => (
    <Dialog
      open
      onOpenChange={() => {}}
      size="sm"
      title="Revoke API key?"
      description="Scripts using this key stop working at once. This cannot be undone."
      footer={
        <>
          <Button>Cancel</Button>
          <Button variant="danger">Revoke key</Button>
        </>
      }
    />
  ),
};

const openDialog = async (canvasElement: HTMLElement) => {
  const opener = within(canvasElement).getByRole('button', { name: 'New issue' });
  opener.focus();
  await userEvent.keyboard('{Enter}');
  const dialog = await screen.findByRole('dialog', { name: 'Create issue' });
  return { opener, dialog };
};

/**
 * Focus starts in the first field and is trapped; Esc closes; focus returns to the opener even
 * though it is not a Radix trigger (the overlay manager restores it).
 */
export const FocusAndEscape: Story = {
  render: () => <Opener />,
  play: async ({ canvasElement }) => {
    const { opener, dialog } = await openDialog(canvasElement);
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    await waitFor(() => expect(title).toHaveFocus());
    await expect(overlayManager.topLayer()?.kind).toBe('modal');

    // Description, Cancel, Create issue, Close, then back to the first field.
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
    await userEvent.tab();
    await expect(title).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
    await expect(overlayManager.topLayer()).toBeUndefined();
  },
};

/** Esc closes the top-most layer only: first the menu inside the dialog, then the dialog. */
export const StackedEscape: Story = {
  render: () => <Opener withMenu />,
  play: async ({ canvasElement }) => {
    const { opener, dialog } = await openDialog(canvasElement);
    const more = within(dialog).getByRole('button', { name: 'More options' });
    await userEvent.click(more);
    const item = await screen.findByRole('menuitem', { name: 'Use template' });
    // Stacked above the dialog, not hidden behind it (z-index).
    await expect(isOnTop(item)).toBe(true);
    await expect(overlayManager.getSnapshot().layers.map((l) => l.kind)).toEqual(['modal', 'menu']);

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await expect(screen.getByRole('dialog', { name: 'Create issue' })).toBeInTheDocument();
    await waitFor(() => expect(more).toHaveFocus());
    await expect(overlayManager.getSnapshot().layers.map((l) => l.kind)).toEqual(['modal']);

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  },
};

/**
 * With unsaved changes, every way of closing asks first. Esc on the question keeps editing (focus
 * back in the field); Discard closes both and returns focus to the opener.
 */
export const DiscardChanges: Story = {
  render: () => <Opener />,
  play: async ({ canvasElement }) => {
    const { opener, dialog } = await openDialog(canvasElement);
    const title = within(dialog).getByRole('textbox', { name: 'Title' });
    await waitFor(() => expect(title).toHaveFocus());
    await userEvent.keyboard('Fix login redirect');

    await userEvent.keyboard('{Escape}');
    const confirm = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
    await waitFor(() =>
      expect(within(confirm).getByRole('button', { name: 'Keep editing' })).toHaveFocus(),
    );
    await expect(overlayManager.getSnapshot().layers.map((l) => l.kind)).toEqual([
      'modal',
      'modal',
    ]);

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await expect(screen.getByRole('dialog', { name: 'Create issue' })).toBeInTheDocument();
    await waitFor(() => expect(title).toHaveFocus());

    // The close button and an outside click ask too.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep editing' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    const backdrop = dialog.previousElementSibling;
    if (backdrop === null) throw new Error('No backdrop');
    await userEvent.click(backdrop);
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep editing' }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await expect(screen.getByRole('dialog', { name: 'Create issue' })).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    const again = await screen.findByRole('alertdialog', { name: 'Discard changes?' });
    await userEvent.click(within(again).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
    await expect(overlayManager.topLayer()).toBeUndefined();
  },
};

function DeletableRow() {
  const [exists, setExists] = useState(true);
  const [open, setOpen] = useState(false);
  return (
    <main tabIndex={-1} aria-label="Issues" className={styles.page}>
      {exists && <Button onClick={() => setOpen(true)}>ENG-1 actions</Button>}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="sm"
        title="Delete ENG-1?"
        footer={
          <Button
            variant="danger"
            onClick={() => {
              setExists(false);
              setOpen(false);
            }}
          >
            Delete issue
          </Button>
        }
      />
    </main>
  );
}

/** When the opener is gone (its row was deleted), focus falls back to the main region. */
export const FocusFallback: Story = {
  render: () => <DeletableRow />,
  play: async ({ canvasElement }) => {
    within(canvasElement).getByRole('button', { name: 'ENG-1 actions' }).focus();
    await userEvent.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Delete ENG-1?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete issue' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(within(canvasElement).getByRole('main')).toHaveFocus());
  },
};

/** Ends with the question open, so axe checks the alert dialog too (AC-12). */
export const DiscardQuestion: Story = {
  render: () => <Opener />,
  play: async ({ canvasElement }) => {
    const { dialog } = await openDialog(canvasElement);
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Draft');
    await userEvent.keyboard('{Escape}');
    await screen.findByRole('alertdialog', { name: 'Discard changes?' });
  },
};

/** Closed by its owner (e.g. the issue was deleted elsewhere) while asking: the question goes too. */
function ClosedByOwner() {
  const [open, setOpen] = useState(true);
  const [title, setTitle] = useState('');
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Edit issue"
      dirty={title !== ''}
      footer={
        // Stands in for an external close (a sync delta); the dialog's own guard is bypassed.
        <Button onClick={() => setOpen(false)} data-external-close="">
          Simulate remote delete
        </Button>
      }
    >
      <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
    </Dialog>
  );
}

export const ClosedWhileAsking: Story = {
  render: () => <ClosedByOwner />,
  play: async () => {
    const dialog = await screen.findByRole('dialog', { name: 'Edit issue' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Title' }), 'Draft');
    await userEvent.keyboard('{Escape}');
    await screen.findByRole('alertdialog', { name: 'Discard changes?' });
    // The owner closes the dialog (its button sits under the question, so press it directly).
    dialog.querySelector<HTMLButtonElement>('[data-external-close]')?.click();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  },
};

function MenuThenDialog() {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.page}>
      <Menu
        trigger={<IconButton aria-label="More actions" icon={<Ellipsis />} variant="secondary" />}
        items={[{ type: 'item', label: 'Delete…', onSelect: () => setOpen(true) }]}
      />
      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="sm"
        title="Delete ENG-1?"
        footer={
          <DialogClose>
            <Button>Cancel</Button>
          </DialogClose>
        }
      />
    </div>
  );
}

/**
 * A dialog opened from a menu item returns focus to the menu's trigger: the item itself is gone
 * by then (SPEC-005 §6 "restore it to the trigger").
 */
export const OpenedFromMenu: Story = {
  render: () => <MenuThenDialog />,
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'More actions' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Delete…' })).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: 'Delete ENG-1?' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  },
};
