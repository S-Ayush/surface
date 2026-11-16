// Stories for the activity stream (PLAN-012 S4b, SPEC-012 AC-11 story half, §7.4). Beside the
// component, like the comment card's (`packages/ui`'s `.storybook/main.ts` lists `apps/web`). Plain
// CSF without Storybook imports. Axe runs on every story in light and dark. A thread here is a
// stand-in `li`: the real one (`ThreadView`) reads the page's comment context, and the comment card
// has its own stories.
import type { ReactNode } from 'react';
import { ActivityStream } from './ActivityStream.js';
import { activityItems, historyRows } from './activity-model.js';
import type { Thread } from '../comments/model.js';

export default { title: 'Domain/ActivityStream' };

const NOW = new Date('2026-11-16T12:00:00.000Z');
const ISSUE = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
const TEAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const ADA = '0192f0c1-7e5a-7b3c-9d4e-0000000000a1';
const IRIS = '0192f0c1-7e5a-7b3c-9d4e-0000000000a2';
const NAMES: Record<string, string> = { [ADA]: 'Ada', [IRIS]: 'Iris' };

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const uuid = (n: number) => `0192f0c1-7e5a-7b3c-9d4e-${String(n).padStart(12, '0')}`;

function entry(n: number, h: number, fields: Record<string, unknown>) {
  return {
    id: uuid(900 + n),
    issueId: ISSUE,
    teamId: TEAM,
    actorKind: 'user',
    actorId: ADA,
    apiKeyId: null,
    kind: 'updated',
    changes: {},
    createdAt: hoursAgo(h),
    updatedAt: hoursAgo(h),
    ...fields,
  };
}

const status = (from: string, to: string) => ({
  status: {
    from: { id: uuid(1), name: from, category: 'unstarted' },
    to: { id: uuid(2), name: to, category: 'started' },
  },
});

const HISTORY = historyRows([
  entry(1, 50, { kind: 'created', changes: { title: { to: 'Login page flickers' } } }),
  entry(2, 30, { changes: status('Todo', 'In Progress') }),
  entry(3, 20, {
    actorId: IRIS,
    changes: { assignee: { from: null, to: { id: IRIS, name: 'Iris' } } },
  }),
  entry(4, 10, {
    actorKind: 'api',
    changes: {
      priority: { from: 0, to: 2 },
      labels: { added: [{ id: uuid(3), name: 'Bug', color: 'red' }], removed: [] },
    },
  }),
  entry(5, 5, { actorKind: 'mcp', changes: { description: true } }),
  entry(6, 2, { actorKind: 'system', actorId: null, changes: status('In Progress', 'Done') }),
  entry(7, 1, { actorKind: 'system', actorId: null, kind: 'archived' }),
]);

const thread = (n: number, h: number): Thread => ({
  root: {
    id: uuid(700 + n),
    issueId: ISSUE,
    teamId: TEAM,
    parentCommentId: null,
    userId: IRIS,
    actorKind: 'user',
    body: { type: 'doc', content: [] },
    version: 1,
    editedAt: null,
    deletedAt: null,
    resolvedAt: null,
    resolvedById: null,
    createdAt: hoursAgo(h),
    updatedAt: hoursAgo(h),
  },
  replies: [],
  resolved: false,
});

const renderThread = (t: Thread): ReactNode => (
  <li>
    <article
      aria-label={`Comment by Iris, ${t.root.createdAt}`}
      style={{
        padding: 'var(--space-12)',
        border: 'var(--border-width) solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--text-primary)',
      }}
    >
      A comment thread (see the comment card stories)
    </article>
  </li>
);

function Column({ children }: { children: ReactNode }) {
  return <div style={{ maxWidth: 'var(--content-max-width)' }}>{children}</div>;
}

const actorName = (row: { actorId: string | null }) =>
  row.actorId === null ? 'Surface' : (NAMES[row.actorId] ?? 'Someone');

/** History lines in SPEC-011's wording, "via API" and "via MCP", the system's lines, a thread. */
export const Stream = {
  render: () => (
    <Column>
      <ActivityStream
        items={activityItems(HISTORY, [thread(1, 25)])}
        actorName={actorName}
        now={NOW}
        renderThread={renderThread}
      />
    </Column>
  ),
};

/** More than 30 items: the newest 30 under "Show 12 earlier" (SPEC-012 D18). */
export const Long = {
  render: () => (
    <Column>
      <ActivityStream
        items={activityItems(
          historyRows(
            Array.from({ length: 42 }, (_, i) =>
              entry(100 + i, 100 - i, { changes: status(`Step ${i}`, `Step ${i + 1}`) }),
            ),
          ),
          [],
        )}
        actorName={actorName}
        now={NOW}
        renderThread={renderThread}
      />
    </Column>
  ),
};
