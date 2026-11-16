// The commands of a focused comment (SPEC-013 §7: the `comment` context; SPEC-012 §3.6: `R`). Each
// acts on the comment that has focus in the timeline (`focusedId`), and is unavailable when the
// comment can't take it, so the menu and the keys say so. Edit, delete, reply and the reaction
// picker are the card's own state: they leave a request for it (`ask`). Resolve, reopen and the
// copies need none.
import type { DocNodeJSON } from '@surface/domain';
import { use } from 'react';
import { TargetContext } from '../../command-menu/context.js';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import type { CommentActions } from './actions.js';
import type { CommentRequest } from './env.js';
import type { CommentRow } from './model.js';

export interface CommentCommandDeps {
  readonly comments: readonly CommentRow[];
  readonly focusedId: string | null;
  readonly me: string | null;
  readonly isAdmin: boolean;
  readonly readOnly: boolean;
  readonly actions: CommentActions | null;
  readonly ask: (kind: CommentRequest['kind'], id: string) => void;
  readonly copyLink: (commentId: string) => void;
  readonly copyMarkdown: (doc: DocNodeJSON) => void;
  /** **New issue from comment…** (SPEC-013 §3.3). */
  readonly newIssue: (doc: DocNodeJSON) => void;
}

export function useCommentCommands(deps: CommentCommandDeps): void {
  const targets = use(TargetContext);
  const focused = (): CommentRow | undefined =>
    deps.focusedId === null
      ? undefined
      : deps.comments.find((comment) => comment.id === deps.focusedId);
  const rootOf = (comment: CommentRow): CommentRow | undefined =>
    comment.parentCommentId === null
      ? comment
      : deps.comments.find((other) => other.id === comment.parentCommentId);
  const live = () => {
    const comment = focused();
    return comment !== undefined && !deps.readOnly ? comment : undefined;
  };
  const text = () => {
    const comment = focused();
    return comment !== undefined && comment.deletedAt === null ? comment : undefined;
  };
  const mine = () => {
    const comment = live();
    return comment !== undefined && comment.deletedAt === null && comment.userId === deps.me
      ? comment
      : undefined;
  };
  const deletable = () => {
    const comment = live();
    return comment !== undefined &&
      comment.deletedAt === null &&
      (comment.userId === deps.me || deps.isAdmin)
      ? comment
      : undefined;
  };
  const resolved = () => {
    const comment = live();
    return comment === undefined ? undefined : rootOf(comment);
  };

  // `R` on a focused comment: the thread's reply box.
  useCommand(
    'comment:reply',
    () => {
      const comment = live();
      if (comment !== undefined) deps.ask('reply', comment.id);
    },
    { when: () => live() !== undefined },
  );
  useCommand(
    'comment:edit',
    () => {
      const comment = mine();
      if (comment !== undefined) deps.ask('edit', comment.id);
    },
    { when: () => mine() !== undefined },
  );
  useCommand(
    'comment:delete',
    () => {
      const comment = deletable();
      if (comment !== undefined) deps.ask('delete', comment.id);
    },
    { when: () => deletable() !== undefined },
  );
  useCommand(
    'comment:resolve',
    () => {
      const root = resolved();
      if (root !== undefined) void deps.actions?.resolve(root.id);
    },
    { when: () => resolved()?.resolvedAt === null },
  );
  useCommand(
    'comment:reopen',
    () => {
      const root = resolved();
      if (root !== undefined) void deps.actions?.reopen(root.id);
    },
    {
      when: () => {
        const root = resolved();
        return root !== undefined && root.resolvedAt !== null;
      },
    },
  );
  useCommand(
    'comment:copy-link',
    () => {
      const comment = focused();
      if (comment !== undefined) deps.copyLink(comment.id);
    },
    { when: () => focused() !== undefined },
  );
  useCommand(
    'comment:copy-markdown',
    () => {
      const comment = text();
      if (comment !== undefined) deps.copyMarkdown(comment.body);
    },
    { when: () => text() !== undefined },
  );
  useCommand(
    'comment:new-issue',
    () => {
      const comment = text();
      if (comment !== undefined) deps.newIssue(comment.body);
    },
    { when: () => text() !== undefined },
  );
  // "Add reaction…" on the focused comment; with the issue as the target, the issue's own row
  // answers (`IssueReactions`).
  useCommand(
    'reaction:add',
    () => {
      const comment = live();
      if (comment !== undefined && comment.deletedAt === null) deps.ask('react', comment.id);
    },
    { when: () => targets?.current().kind === 'comment' && text() !== undefined && !deps.readOnly },
  );
}
