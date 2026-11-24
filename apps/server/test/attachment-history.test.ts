// PLAN-014 S4a, SPEC-014 AC-11 (§6.3): adding and removing an attachment writes an `updated`
// history entry on the issue, `attachments: { added, removed }` with `{id, kind, title}`; the
// creator's changes within 3 minutes of creating the issue fold into `created`, netted (an
// attachment added then removed leaves nothing); renames and previews write none.
import { randomUUID } from 'node:crypto';
import { CREATOR_FOLD_MS } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import {
  createLinkAttachment,
  deleteAttachment,
  renameAttachment,
} from '../src/handlers/attachment/core.js';
import { createIssue } from '../src/handlers/issues/core.js';
import { attachmentId, memoryAttachments } from './support/memory-attachments.js';
import { ADA_ACTOR, ADA_ID, memoryIssues, NOW } from './support/memory-issues.js';

const IRIS_ID = '0192f0c1-7e5a-7b3c-9d4e-0000000001e1';

async function world() {
  const m = memoryIssues();
  const issue = await createIssue(m.ctx, {
    id: randomUUID(),
    team: m.eng,
    teamRef: 'ENG',
    title: 'Fix login',
    assigneeId: null,
    labelIds: [],
    estimate: null,
    dueDate: null,
    creatorId: ADA_ID,
  });
  const a = memoryAttachments(m);
  const link = (title: string) =>
    createLinkAttachment(a.ctx(), {
      id: attachmentId(),
      issueId: issue.id,
      url: 'https://example.com/spec',
      title,
      creatorId: m.ctx.actor.userId ?? ADA_ID,
    });
  const target = (row: { id: string }) => ({
    attachmentId: row.id,
    issueId: issue.id,
    ref: row.id,
  });
  return { m, a, issue, link, target };
}

const later = (ms: number) => new Date(NOW.getTime() + ms);

describe('attachment history (AC-11)', () => {
  it('records an added and a removed attachment with its title, after the fold window', async () => {
    const { m, a, link, target } = await world();
    m.at(later(CREATOR_FOLD_MS + 1));
    const row = await link('Login spec');
    m.at(later(CREATOR_FOLD_MS + 60_000));
    await deleteAttachment(a.ctx(), target(row));
    expect(m.historyRows.map((h) => [h.kind, h.changes])).toEqual([
      ['created', expect.any(Object)],
      [
        'updated',
        {
          attachments: { added: [{ id: row.id, kind: 'link', title: 'Login spec' }], removed: [] },
        },
      ],
      [
        'updated',
        {
          attachments: { added: [], removed: [{ id: row.id, kind: 'link', title: 'Login spec' }] },
        },
      ],
    ]);
  });

  it('folds the creator’s attachments within 3 minutes into created', async () => {
    const { m, link } = await world();
    m.at(later(60_000));
    const first = await link('Login spec');
    m.at(later(CREATOR_FOLD_MS));
    const second = await link('HAR export');
    expect(m.historyRows).toHaveLength(1);
    expect(m.historyRows[0]?.kind).toBe('created');
    expect(m.historyRows[0]?.changes).toMatchObject({
      attachments: {
        added: [
          { id: first.id, kind: 'link', title: 'Login spec' },
          { id: second.id, kind: 'link', title: 'HAR export' },
        ],
        removed: [],
      },
    });
  });

  it('nets an attachment the creator adds and removes within the window out of created', async () => {
    const { m, a, link, target } = await world();
    const row = await link('Oops');
    await deleteAttachment(a.ctx(), target(row));
    expect(m.historyRows).toHaveLength(1);
    expect(m.historyRows[0]?.changes).not.toHaveProperty('attachments');
  });

  it('does not fold someone else’s attachment into created', async () => {
    const { m, link } = await world();
    m.as({ ...ADA_ACTOR, userId: IRIS_ID, groups: ['workspace', `user:${IRIS_ID}`] });
    const row = await link('From Iris');
    expect(m.historyRows.map((h) => h.kind)).toEqual(['created', 'updated']);
    expect(m.historyRows[1]?.changes).toEqual({
      attachments: { added: [{ id: row.id, kind: 'link', title: 'From Iris' }], removed: [] },
    });
  });

  it('writes no entry for a rename', async () => {
    const { m, a, link, target } = await world();
    m.at(later(CREATOR_FOLD_MS + 1));
    const row = await link('Login spec');
    const entries = m.historyRows.length;
    await renameAttachment(a.ctx(), target(row), 'Login flow');
    expect(m.historyRows).toHaveLength(entries);
  });
});
