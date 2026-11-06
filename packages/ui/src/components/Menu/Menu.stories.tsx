import type { Meta, StoryObj } from '@storybook/react-vite';
import { Archive, Copy, Ellipsis, Link, Pencil, Tag } from 'lucide-react';
import { useState } from 'react';
import { expect, fireEvent, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { overlayManager } from '../../overlays/manager.js';
import { IconButton } from '../IconButton/IconButton.js';
import { ContextMenu, Menu, type MenuEntry } from './Menu.js';
import styles from './Menu.stories.module.css';

const meta = { title: 'Overlays/Menu' } satisfies Meta;
export default meta;
type Story = StoryObj;

type Handlers = {
  onSelect: (action: string) => void;
  subscribed: boolean;
  onSubscribed: (v: boolean) => void;
};

/** The same entries feed the `⋯` menu and the right-click menu (FR-NAV-11). */
function issueActions({ onSelect, subscribed, onSubscribed }: Handlers): MenuEntry[] {
  return [
    { type: 'label', label: 'ENG-12' },
    {
      type: 'item',
      label: 'Edit title',
      icon: <Pencil />,
      shortcut: 'Mod+E',
      onSelect: () => onSelect('edit'),
    },
    {
      type: 'item',
      label: 'Copy link',
      icon: <Link />,
      shortcut: 'Mod+Shift+,',
      onSelect: () => onSelect('copy-link'),
    },
    { type: 'item', label: 'Duplicate', icon: <Copy />, onSelect: () => onSelect('duplicate') },
    {
      type: 'submenu',
      label: 'Labels',
      icon: <Tag />,
      items: [
        { type: 'item', label: 'Bug', onSelect: () => onSelect('label-bug') },
        { type: 'item', label: 'Feature', onSelect: () => onSelect('label-feature') },
      ],
    },
    { type: 'separator' },
    { type: 'checkbox', label: 'Subscribed', checked: subscribed, onCheckedChange: onSubscribed },
    {
      type: 'item',
      label: 'Archive',
      icon: <Archive />,
      disabled: true,
      onSelect: () => onSelect('archive'),
    },
  ];
}

function IssueMenu({
  onSelect = () => {},
  defaultOpen,
}: {
  onSelect?: (a: string) => void;
  defaultOpen?: boolean;
}) {
  const [subscribed, setSubscribed] = useState(true);
  return (
    <Menu
      defaultOpen={defaultOpen}
      trigger={<IconButton aria-label="More actions" icon={<Ellipsis />} variant="secondary" />}
      items={issueActions({ onSelect, subscribed, onSubscribed: setSubscribed })}
    />
  );
}

function IssueRow({ onSelect = () => {} }: { onSelect?: (a: string) => void }) {
  const [subscribed, setSubscribed] = useState(true);
  return (
    <ContextMenu items={issueActions({ onSelect, subscribed, onSubscribed: setSubscribed })}>
      {/* Focusable, so Shift+F10 or the context-menu key can open it from the keyboard. */}
      <div className={styles.area} tabIndex={0}>
        Right-click this row for its actions
      </div>
    </ContextMenu>
  );
}

export const Open: Story = {
  render: () => <IssueMenu defaultOpen />,
};

const onSelect = fn();

/**
 * Enter opens on the first item; arrows move; type-ahead jumps; Right/Left open and close a
 * submenu (Esc closes the whole menu, as on macOS); selecting runs the action and returns focus.
 */
export const Keyboard: Story = {
  render: () => <IssueMenu onSelect={onSelect} />,
  play: async ({ canvasElement }) => {
    onSelect.mockClear();
    const trigger = within(canvasElement).getByRole('button', { name: 'More actions' });
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    await expect(overlayManager.topLayer()?.kind).toBe('menu');
    const item = (name: string) => within(menu).getByRole('menuitem', { name });
    await waitFor(() => expect(item('Edit title')).toHaveFocus());
    await expect(item('Edit title')).toHaveAttribute('aria-keyshortcuts', 'Meta+E');

    await userEvent.keyboard('{ArrowDown}');
    await expect(item('Copy link')).toHaveFocus();
    await userEvent.keyboard('l');
    await waitFor(() => expect(item('Labels')).toHaveFocus());

    await userEvent.keyboard('{ArrowRight}');
    const submenu = (await screen.findAllByRole('menu')).at(-1);
    if (submenu === undefined) throw new Error('No submenu');
    await waitFor(() =>
      expect(within(submenu).getByRole('menuitem', { name: 'Bug' })).toHaveFocus(),
    );
    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(1));
    await expect(item('Labels')).toHaveFocus();

    const subscribed = within(menu).getByRole('menuitemcheckbox', { name: 'Subscribed' });
    await expect(subscribed).toHaveAttribute('aria-checked', 'true');
    await expect(item('Archive')).toHaveAttribute('aria-disabled', 'true');

    await userEvent.keyboard('{ArrowUp}{ArrowUp}{Enter}');
    await expect(onSelect).toHaveBeenCalledWith('copy-link');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    await expect(overlayManager.topLayer()).toBeUndefined();
  },
};

/** A checkbox item toggles and the menu reports the new state. */
export const CheckboxItem: Story = {
  render: () => <IssueMenu />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Subscribed' }));
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'More actions' }));
    await expect(
      await screen.findByRole('menuitemcheckbox', { name: 'Subscribed' }),
    ).toHaveAttribute('aria-checked', 'false');
    await userEvent.keyboard('{Escape}');
  },
};

/** Right-click opens the same items as the `⋯` menu; Esc closes it. */
export const ContextMenuKeyboard: Story = {
  name: 'Context menu',
  render: () => <IssueRow onSelect={onSelect} />,
  play: async ({ canvasElement }) => {
    onSelect.mockClear();
    const area = within(canvasElement).getByText('Right-click this row for its actions');
    await userEvent.pointer({ keys: '[MouseRight]', target: area });
    const menu = await screen.findByRole('menu');
    await expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((el) => el.textContent),
    ).toEqual([
      expect.stringContaining('Edit title'),
      expect.stringContaining('Copy link'),
      'Duplicate',
      'Labels',
      'Archive',
    ]);
    await expect(overlayManager.topLayer()?.kind).toBe('menu');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await expect(overlayManager.topLayer()).toBeUndefined();
  },
};

/**
 * Keyboard path: Shift+F10 or the context-menu key fire a `contextmenu` event on the focused row
 * (the browser does this; synthesised here). Arrows and Enter pick an item; focus returns to the row.
 */
export const ContextMenuFromKeyboard: Story = {
  name: 'Context menu from keyboard',
  render: () => <IssueRow onSelect={onSelect} />,
  play: async ({ canvasElement }) => {
    onSelect.mockClear();
    const row = within(canvasElement).getByText('Right-click this row for its actions');
    row.focus();
    await fireEvent.contextMenu(row);
    const menu = await screen.findByRole('menu');
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(within(menu).getByRole('menuitem', { name: /Edit title/ })).toHaveFocus(),
    );
    await userEvent.keyboard('{Enter}');
    await expect(onSelect).toHaveBeenCalledWith('edit');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await waitFor(() => expect(row).toHaveFocus());
  },
};

/** Ends with a submenu open, so axe checks it too (AC-12). */
export const SubmenuOpen: Story = {
  render: () => <IssueMenu />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'More actions' }));
    const labels = await screen.findByRole('menuitem', { name: 'Labels' });
    labels.focus();
    await userEvent.keyboard('{ArrowRight}');
    await screen.findByRole('menuitem', { name: 'Bug' });
  },
};
