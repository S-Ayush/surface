// Stories for the comment card and the resolved thread (PLAN-013 S5, SPEC-013 AC-17 axe half). They
// live beside the components because `packages/ui` may not import the editor; `.storybook/main.ts`
// of `packages/ui` lists this folder. Plain CSF without Storybook imports, so `apps/web` needs no
// Storybook dependency. Axe runs on every story in light and dark (`a11y: { test: 'error' }`).
import type { DocNodeJSON } from '@surface/domain';
import type { ReactNode } from 'react';
import { CommentCard } from './CommentCard.js';
import { commentMenu } from './CommentMenu.js';
import { ResolvedThreadLine } from './ResolvedThreadLine.js';
import styles from './comments.module.css';

export default { title: 'Domain/CommentCard' };

const NOW = new Date('2026-11-16T12:00:00.000Z');
const THREE_HOURS_AGO = '2026-11-16T09:00:00.000Z';
const YESTERDAY = '2026-11-15T09:00:00.000Z';

const text = (value: string) => ({ type: 'text', text: value });
const BODY: DocNodeJSON = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        text('I can reproduce this on '),
        { type: 'text', text: 'Safari', marks: [{ type: 'bold' }] },
        text(' too.'),
      ],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [text('Open the login page')] }],
        },
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [text('Resize the window')] }],
        },
      ],
    },
  ],
};

const SHORT: DocNodeJSON = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [text('Fixed in the latest build.')] }],
};

const noop = () => undefined;
const loadEmoji = () => Promise.resolve([]);
const menu = commentMenu({
  resolved: false,
  deleted: false,
  mine: true,
  canDelete: true,
  onToggleResolved: noop,
  onCopyLink: noop,
  onCopyMarkdown: noop,
  onNewIssue: noop,
  onEdit: noop,
  onDelete: noop,
});

const CHIPS = [
  { emoji: '👍', count: 3, mine: true, label: 'thumbs up', people: ['You', 'Iris', 'Sam'] },
  { emoji: '🎉', count: 1, mine: false, label: 'party popper', people: ['Iris'] },
];

const base = {
  now: NOW,
  loadEmoji,
  onReact: noop,
  chips: [],
  via: null,
  editedAt: null,
} as const;

function Column({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-12)',
        maxWidth: 'var(--content-max-width)',
      }}
    >
      {children}
    </div>
  );
}

/** A comment with rich text, reactions and the options menu. */
export const Comment = {
  render: () => (
    <Column>
      <CommentCard
        {...base}
        id="c1"
        authorName="Iris West"
        createdAt={THREE_HOURS_AGO}
        body={BODY}
        chips={CHIPS}
        onReply={noop}
        menu={menu}
      />
    </Column>
  ),
};

/** The other states of a card: edited and via the API, pending, deleted, linked and read-only. */
export const States = {
  render: () => (
    <Column>
      <CommentCard
        {...base}
        id="c2"
        authorName="Build bot"
        via="api"
        createdAt={YESTERDAY}
        editedAt={THREE_HOURS_AGO}
        body={SHORT}
        onReply={noop}
        menu={menu}
      />
      <CommentCard
        {...base}
        id="c3"
        authorName="Ada Lovelace"
        createdAt={THREE_HOURS_AGO}
        body={SHORT}
        pending
      />
      <CommentCard
        {...base}
        id="c4"
        authorName="Iris West"
        createdAt={YESTERDAY}
        body={SHORT}
        deleted
      />
      <CommentCard
        {...base}
        id="c5"
        authorName="Sam Reyes"
        createdAt={THREE_HOURS_AGO}
        body={SHORT}
        highlighted
        onReply={noop}
        menu={menu}
      />
      <CommentCard
        {...base}
        id="c6"
        authorName="Ada Lovelace"
        createdAt={THREE_HOURS_AGO}
        body={SHORT}
        chips={CHIPS}
        readOnly
      />
    </Column>
  ),
};

/** A thread: the root, its replies under it. */
export const Thread = {
  render: () => (
    <Column>
      <CommentCard
        {...base}
        id="t1"
        authorName="Iris West"
        createdAt={YESTERDAY}
        body={BODY}
        onReply={noop}
        menu={menu}
      />
      <ul className={styles.replies} aria-label="Replies">
        <li>
          <CommentCard
            {...base}
            id="t2"
            authorName="Ada Lovelace"
            createdAt={THREE_HOURS_AGO}
            body={SHORT}
            onReply={noop}
            menu={menu}
          />
        </li>
      </ul>
    </Column>
  ),
};

/** A resolved thread: one line, then expanded with its replies (SPEC-013 §3.3a). */
export const ResolvedThread = {
  render: () => (
    <Column>
      <ResolvedThreadLine
        id="r1"
        text="Does this happen on Safari?"
        resolvedBy="Ada Lovelace"
        resolvedAt="2026-11-16T10:00:00.000Z"
        now={NOW}
        expanded={false}
        onToggle={noop}
        onReopen={noop}
      />
      <ResolvedThreadLine
        id="r2"
        text="Old question about caching"
        resolvedBy="Ada Lovelace"
        resolvedAt="2026-11-14T10:00:00.000Z"
        now={NOW}
        expanded
        onToggle={noop}
        onReopen={noop}
      />
      <CommentCard
        {...base}
        id="r3"
        authorName="Iris West"
        createdAt={YESTERDAY}
        body={SHORT}
        readOnly
      />
      <ResolvedThreadLine
        id="r4"
        text="Resolved on an archived issue"
        resolvedBy="Sam Reyes"
        resolvedAt="2026-11-10T10:00:00.000Z"
        now={NOW}
        expanded={false}
        onToggle={noop}
      />
    </Column>
  ),
};
