// The comment's options menu (SPEC-013 §3.3, Linear's, D7). Pure: the card says what applies and
// supplies the handlers, so the entries and their order are tested without a menu.
import type { MenuEntry } from '@surface/ui';
import {
  Check,
  Copy,
  FileText,
  Pencil,
  RotateCcw,
  SquarePen,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { createElement } from 'react';

export interface CommentMenuOptions {
  /** The thread is resolved: the entry reads **Reopen thread**. */
  readonly resolved: boolean;
  /** A placeholder keeps only the thread entries: there is no text to copy or edit. */
  readonly deleted: boolean;
  readonly mine: boolean;
  /** The author, or an Admin (§5.2). */
  readonly canDelete: boolean;
  /** "New issue from comment…" is hidden until the composer can carry a description. */
  readonly composerAvailable: boolean;
  readonly onToggleResolved: () => void;
  readonly onCopyLink: () => void;
  readonly onCopyMarkdown: () => void;
  readonly onNewIssue: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}

const icon = (Icon: LucideIcon) => createElement(Icon);

export function commentMenu(options: CommentMenuOptions): MenuEntry[] {
  const entries: MenuEntry[] = [
    {
      type: 'item',
      label: options.resolved ? 'Reopen thread' : 'Resolve thread',
      icon: icon(options.resolved ? RotateCcw : Check),
      onSelect: options.onToggleResolved,
    },
  ];
  if (!options.deleted) {
    entries.push(
      {
        type: 'item',
        label: 'Copy link to comment',
        icon: icon(Copy),
        onSelect: options.onCopyLink,
      },
      {
        type: 'item',
        label: 'Copy content as Markdown',
        icon: icon(FileText),
        onSelect: options.onCopyMarkdown,
      },
    );
    if (options.composerAvailable) {
      entries.push({
        type: 'item',
        label: 'New issue from comment…',
        icon: icon(SquarePen),
        onSelect: options.onNewIssue,
      });
    }
  }
  const writes: MenuEntry[] = [];
  if (options.mine && !options.deleted) {
    writes.push({ type: 'item', label: 'Edit', icon: icon(Pencil), onSelect: options.onEdit });
  }
  if (options.canDelete && !options.deleted) {
    writes.push({ type: 'item', label: 'Delete', icon: icon(Trash2), onSelect: options.onDelete });
  }
  return writes.length === 0 ? entries : [...entries, { type: 'separator' }, ...writes];
}
