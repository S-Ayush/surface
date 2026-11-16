// Makes the focused comment the command target (the chip in `Mod+K` and the `comment` context),
// while it is mounted. A component, not a hook call in the section: focus on the comment box or on
// the page leaves the page's own target (the issue) in place. Like the issue list's `RowTarget`.
import { useCommandContext } from '../../command-menu/context.js';

export function CommentTarget({ id, label }: { id: string; label: string }) {
  useCommandContext({ kind: 'comment', ids: [id], label }, 'focus');
  return null;
}
