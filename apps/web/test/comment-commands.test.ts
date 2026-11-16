// PLAN-013 S5, SPEC-013 §7 "Command menu": the `issue` context gains **Comment…** and **Add
// reaction…**; the `comment` context (a focused comment) lists Edit, Delete, Add reaction…, Resolve
// or Reopen thread, and the two copies. An entry shows only while its handler is registered, so the
// menu never offers what the page can't do.
import { registry } from '@surface/operations';
import { describe, expect, it, vi } from 'vitest';
import type { CommandId } from '../src/commands/catalog.js';
import { CommandRegistry } from '../src/commands/registry.js';
import type { Command, CommandContext, CommandTarget } from '../src/command-menu/model.js';
import { rankCommands } from '../src/command-menu/ranking.js';
import { appSource } from '../src/command-menu/sources/app.js';
import { checkOperationCommands, operationSource } from '../src/command-menu/sources/operations.js';
import { OPERATION_COMMANDS } from '../src/features/commands.js';
import { COMMENT_COMMANDS } from '../src/features/comments/commands.js';
import { commentMenu } from '../src/features/comments/CommentMenu.js';
import { context, member, noBoost } from './command-fixtures.js';

const ISSUE: CommandTarget = { kind: 'issue', ids: ['issue-1'], label: 'ENG-42' };
const COMMENT: CommandTarget = { kind: 'comment', ids: ['comment-1'], label: 'Comment by Iris' };

const HANDLERS: readonly CommandId[] = [
  'issue-page:comment',
  'reaction:add',
  'comment:edit',
  'comment:delete',
  'comment:resolve',
  'comment:reopen',
  'comment:copy-link',
  'comment:copy-markdown',
  'comment:new-issue',
];

function titles(target: CommandTarget, registered: readonly CommandId[] = HANDLERS): string[] {
  const commands = new CommandRegistry(() => undefined);
  for (const id of registered) commands.register(id, { run: vi.fn() });
  const ctx: CommandContext = context({ target, actor: member });
  const all: Command[] = [
    ...operationSource(registry, commands, OPERATION_COMMANDS)(ctx),
    ...appSource(commands)(ctx),
  ];
  return rankCommands(all, '', ctx, noBoost).flatMap((section) =>
    section.items.map((item) => item.command.title),
  );
}

describe('comment commands in the command menu (SPEC-013 §7)', () => {
  it('passes the operation command checks with refs for every comment operation', () => {
    expect(checkOperationCommands(registry, OPERATION_COMMANDS)).toEqual([]);
  });

  it('offers Comment… and Add reaction… in the issue context', () => {
    const offered = titles(ISSUE);
    expect(offered).toContain('Comment…');
    expect(offered).toContain('Add reaction…');
    // What acts on a comment is not offered for the issue.
    expect(offered).not.toContain('Edit comment');
    expect(offered).not.toContain('Delete comment');
    expect(offered).not.toContain('Copy link to comment');
  });

  it('offers the comment commands for a focused comment, and not Comment…', () => {
    const offered = titles(COMMENT);
    for (const title of [
      'Edit comment',
      'Delete comment',
      'Add reaction…',
      'Resolve thread',
      'Reopen thread',
      'Copy link to comment',
      'Copy content as Markdown',
      'New issue from comment…',
    ]) {
      expect(offered).toContain(title);
    }
    expect(offered).not.toContain('Comment…');
  });

  it('offers an entry only while the page has registered its handler', () => {
    expect(titles(COMMENT, [])).not.toContain('Edit comment');
    expect(titles(ISSUE, [])).not.toContain('Comment…');
    expect(titles(ISSUE, [])).not.toContain('Add reaction…');
    expect(titles(COMMENT, ['comment:copy-link'])).toContain('Copy link to comment');
    expect(titles(COMMENT, ['comment:copy-link'])).not.toContain('Copy content as Markdown');
  });

  it('names the focused comment, or the issue, as the ref the permission check reads', () => {
    const ref = (name: string, target: CommandTarget) =>
      COMMENT_COMMANDS[name]?.refs?.(context({ target }));
    expect(ref('comment.update', COMMENT)).toEqual({ comment: { id: 'comment-1' } });
    expect(ref('comment.delete', COMMENT)).toEqual({ comment: { id: 'comment-1' } });
    expect(ref('comment.resolve', COMMENT)).toEqual({ comment: { id: 'comment-1' } });
    expect(ref('comment.create', ISSUE)).toEqual({ issue: { id: 'issue-1' } });
    expect(ref('reaction.set', ISSUE)).toEqual({ issue: { id: 'issue-1' } });
    expect(ref('reaction.set', COMMENT)).toEqual({ comment: { id: 'comment-1' } });
  });
});

describe("a comment's options menu (SPEC-013 §3.3)", () => {
  const noop = () => undefined;
  const options = {
    resolved: false,
    deleted: false,
    mine: false,
    canDelete: false,
    onToggleResolved: noop,
    onCopyLink: noop,
    onCopyMarkdown: noop,
    onNewIssue: noop,
    onEdit: noop,
    onDelete: noop,
  };
  const labels = (overrides: Partial<typeof options>) =>
    commentMenu({ ...options, ...overrides }).flatMap((entry) =>
      entry.type === 'item' ? [entry.label] : [],
    );

  it('lists Resolve thread, the copies, and Edit and Delete only for the author', () => {
    expect(labels({})).toEqual([
      'Resolve thread',
      'Copy link to comment',
      'Copy content as Markdown',
      'New issue from comment…',
    ]);
    expect(labels({ mine: true, canDelete: true })).toEqual([
      'Resolve thread',
      'Copy link to comment',
      'Copy content as Markdown',
      'New issue from comment…',
      'Edit',
      'Delete',
    ]);
  });

  it('lets an Admin delete without editing', () => {
    expect(labels({ canDelete: true })).toContain('Delete');
    expect(labels({ canDelete: true })).not.toContain('Edit');
  });

  it('reads Reopen thread for a resolved thread', () => {
    expect(labels({ resolved: true })[0]).toBe('Reopen thread');
  });

  it('keeps only the thread entry for a deleted comment with replies', () => {
    expect(labels({ deleted: true, mine: true, canDelete: true })).toEqual(['Resolve thread']);
  });

  it('offers "New issue from comment…" since the composer carries a description (PLAN-011 S6)', () => {
    let opened = 0;
    const entry = commentMenu({
      ...options,
      onNewIssue: () => {
        opened += 1;
      },
    }).find((e) => e.type === 'item' && e.label === 'New issue from comment…');
    if (entry?.type === 'item') entry.onSelect();
    expect(opened).toBe(1);
  });
});
