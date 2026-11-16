// The issue's own reactions, under its description (SPEC-013 §3.4, D8; the page's `reactions` slot).
// Chips and **Add reaction** from the design system, on the issue's `Reaction` rows (`commentId`
// null). It also answers the command **Add reaction…** when the issue is the target.
import { useIssueContent } from '@surface/sync-react';
import { ReactionBar } from '@surface/ui';
import { use, useMemo, useState } from 'react';
import { TargetContext } from '../../command-menu/context.js';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import { loadEmojiLazy, useEmojiNames } from './editor-host.js';
import { reactionChips, reactionRows, reactionsOf } from './model.js';
import { commentActionsFor, useCommentWorld } from './useComments.js';
import styles from './comments.module.css';

/** What the issue page passes a slot (`issues/slots.ts`; not imported, which would be circular). */
type SlotProps = { readonly issueId: string };

export function IssueReactions({ issueId }: SlotProps) {
  const { store, me, userName, issue } = useCommentWorld(issueId);
  const content = useIssueContent(issueId);
  const targets = use(TargetContext);
  const [pickerOpen, setPickerOpen] = useState(false);
  const rows = useMemo(
    () => reactionsOf(reactionRows(content.rows['Reaction']), null),
    [content.rows],
  );
  const names = useEmojiNames(rows.length > 0);
  const ready = content.state === 'ready';
  const readOnly = issue !== undefined && issue.lifecycle !== 'live';

  // "Add reaction…" with the issue as the target opens this picker; a focused comment's own
  // command (`useCommentCommands`) answers when a comment is.
  useCommand(
    'reaction:add',
    () => {
      setPickerOpen(true);
    },
    { when: () => ready && !readOnly && targets?.current().kind !== 'comment' },
  );

  if (store === null || !ready) return null;
  const actions = commentActionsFor(store);
  return (
    <div className={styles.issueReactions} data-slot="issue-reactions">
      <ReactionBar
        reactions={reactionChips(rows, me, userName, (emoji) => names?.get(emoji))}
        readOnly={readOnly}
        loadEmoji={loadEmojiLazy}
        pickerOpen={pickerOpen}
        onPickerOpenChange={setPickerOpen}
        onReact={(emoji, reacted) => {
          void actions.react({ issueId, commentId: null, emoji, reacted });
        }}
      />
    </div>
  );
}
