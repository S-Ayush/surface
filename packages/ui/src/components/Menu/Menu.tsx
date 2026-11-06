import { Check, ChevronRight } from 'lucide-react';
import { ContextMenu as RadixContextMenu, DropdownMenu as RadixDropdownMenu } from 'radix-ui';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import { ariaKeyShortcuts } from '../../keys.js';
import { LayerMarker, useAnchoredLayer } from '../../overlays/layer.js';
import { usePlatform } from '../../platform.js';
import { Kbd } from '../Kbd/Kbd.js';
import { OVERLAY_COLLISION_PADDING, OVERLAY_SIDE_OFFSET } from '../Popover/Popover.js';
import styles from './Menu.module.css';

type Shortcut = string | readonly string[];

/**
 * One list of actions, rendered by both <Menu> (the `⋯` button) and <ContextMenu> (right-click),
 * so the two always offer the same items (design-system §5.2, FR-NAV-11).
 */
export type MenuEntry =
  | {
      type: 'item';
      label: string;
      /** A Lucide icon (16 px). */
      icon?: ReactNode;
      /** Shown as <Kbd> and exposed as aria-keyshortcuts; the binding itself lives in the registry. */
      shortcut?: Shortcut;
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      type: 'checkbox';
      label: string;
      shortcut?: Shortcut;
      disabled?: boolean;
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
    }
  | {
      type: 'submenu';
      label: string;
      icon?: ReactNode;
      disabled?: boolean;
      items: readonly MenuEntry[];
    }
  | { type: 'label'; label: string }
  | { type: 'separator' };

/** The Radix parts both menus share. Typed by what this file passes, so either namespace fits. */
type Parts = {
  Item: ComponentType<{
    className?: string;
    disabled?: boolean;
    textValue?: string;
    onSelect?: (event: Event) => void;
    'aria-keyshortcuts'?: string;
    children?: ReactNode;
  }>;
  CheckboxItem: ComponentType<{
    className?: string;
    disabled?: boolean;
    textValue?: string;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    'aria-keyshortcuts'?: string;
    children?: ReactNode;
  }>;
  ItemIndicator: ComponentType<{ className?: string; children?: ReactNode }>;
  Label: ComponentType<{ className?: string; children?: ReactNode }>;
  Separator: ComponentType<{ className?: string }>;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<{
    className?: string;
    disabled?: boolean;
    textValue?: string;
    children?: ReactNode;
  }>;
  SubContent: ComponentType<{
    className?: string;
    sideOffset?: number;
    collisionPadding?: number;
    children?: ReactNode;
  }>;
  Portal: ComponentType<{ children?: ReactNode }>;
};

const DROPDOWN_PARTS: Parts = RadixDropdownMenu;
const CONTEXT_PARTS: Parts = RadixContextMenu;

function Entries({ parts, items }: { parts: Parts; items: readonly MenuEntry[] }) {
  const platform = usePlatform();
  const hint = (shortcut: Shortcut | undefined) =>
    shortcut === undefined ? undefined : ariaKeyShortcuts(shortcut, platform);
  const kbd = (shortcut: Shortcut | undefined) =>
    shortcut !== undefined && <Kbd keys={shortcut} className={styles.kbd} aria-hidden="true" />;

  return items.map((entry, index) => {
    switch (entry.type) {
      case 'item':
        return (
          <parts.Item
            key={`${index}-${entry.label}`}
            className={styles.item}
            disabled={entry.disabled}
            onSelect={entry.onSelect}
            // Type-ahead matches the label, not the visually hidden spoken shortcut.
            textValue={entry.label}
            aria-keyshortcuts={hint(entry.shortcut)}
          >
            <span className={styles.icon} aria-hidden="true">
              {entry.icon}
            </span>
            <span className={styles.label}>{entry.label}</span>
            {kbd(entry.shortcut)}
          </parts.Item>
        );
      case 'checkbox':
        return (
          <parts.CheckboxItem
            key={`${index}-${entry.label}`}
            className={styles.item}
            disabled={entry.disabled}
            checked={entry.checked}
            onCheckedChange={entry.onCheckedChange}
            textValue={entry.label}
            aria-keyshortcuts={hint(entry.shortcut)}
          >
            {/* Always takes space, so the label does not shift when the item is toggled. */}
            <span className={styles.check} aria-hidden="true">
              <parts.ItemIndicator>
                <Check />
              </parts.ItemIndicator>
            </span>
            <span className={styles.label}>{entry.label}</span>
            {kbd(entry.shortcut)}
          </parts.CheckboxItem>
        );
      case 'submenu':
        return (
          <parts.Sub key={`${index}-${entry.label}`}>
            <parts.SubTrigger
              className={styles.item}
              disabled={entry.disabled}
              textValue={entry.label}
            >
              <span className={styles.icon} aria-hidden="true">
                {entry.icon}
              </span>
              <span className={styles.label}>{entry.label}</span>
              <ChevronRight className={styles.chevron} aria-hidden="true" />
            </parts.SubTrigger>
            <parts.Portal>
              <parts.SubContent
                className={styles.content}
                sideOffset={OVERLAY_SIDE_OFFSET}
                collisionPadding={OVERLAY_COLLISION_PADDING}
              >
                <LayerMarker kind="menu" />
                <Entries parts={parts} items={entry.items} />
              </parts.SubContent>
            </parts.Portal>
          </parts.Sub>
        );
      case 'label':
        return (
          <parts.Label key={`${index}-${entry.label}`} className={styles.groupLabel}>
            {entry.label}
          </parts.Label>
        );
      case 'separator':
        return <parts.Separator key={`${index}-separator`} className={styles.separator} />;
    }
  });
}

export type MenuProps = {
  /** A single focusable element, usually an <IconButton> named "More actions". */
  trigger: ReactElement;
  items: readonly MenuEntry[];
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * design-system §5.2: items with icon, label, shortcut, submenu and checked state; arrow keys and
 * type-ahead. `→`/`←` open and close a submenu; `Esc` closes the whole menu (Radix, as on macOS).
 */
export function Menu({ trigger, items, align = 'start', ...root }: MenuProps) {
  const layer = useAnchoredLayer('menu');
  return (
    // Non-modal: a modal menu marks the page aria-hidden while its trigger stays focusable (axe
    // aria-hidden-focus). Unlike a modal menu, an outside click also reaches what was clicked, and
    // focus stays there.
    <RadixDropdownMenu.Root modal={false} {...root}>
      <RadixDropdownMenu.Trigger asChild>{trigger}</RadixDropdownMenu.Trigger>
      <RadixDropdownMenu.Portal>
        <RadixDropdownMenu.Content
          className={styles.content}
          align={align}
          sideOffset={OVERLAY_SIDE_OFFSET}
          collisionPadding={OVERLAY_COLLISION_PADDING}
          loop
          onCloseAutoFocus={layer.onCloseAutoFocus}
          onInteractOutside={layer.onInteractOutside}
        >
          {layer.marker}
          <Entries parts={DROPDOWN_PARTS} items={items} />
        </RadixDropdownMenu.Content>
      </RadixDropdownMenu.Portal>
    </RadixDropdownMenu.Root>
  );
}

export type ContextMenuProps = {
  /** The area that opens the menu on right-click (or the context-menu key). */
  children: ReactElement;
  /** Pass the same entries as the area's `⋯` <Menu>, which is how keyboard users reach them. */
  items: readonly MenuEntry[];
  onOpenChange?: (open: boolean) => void;
};

export function ContextMenu({ children, items, onOpenChange }: ContextMenuProps) {
  const layer = useAnchoredLayer('menu');
  return (
    <RadixContextMenu.Root modal={false} onOpenChange={onOpenChange}>
      <RadixContextMenu.Trigger asChild>{children}</RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        <RadixContextMenu.Content
          className={styles.content}
          collisionPadding={OVERLAY_COLLISION_PADDING}
          loop
          onCloseAutoFocus={layer.onCloseAutoFocus}
          onInteractOutside={layer.onInteractOutside}
        >
          {layer.marker}
          <Entries parts={CONTEXT_PARTS} items={items} />
        </RadixContextMenu.Content>
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  );
}
