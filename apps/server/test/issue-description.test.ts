// PLAN-011 S6, SPEC-011 §3.3, §4.3, §6.1, §6.4: the description. AC-6 (unit part: the version
// bump, a stale baseVersion as CONFLICT with no extra fields, the search text written with the
// content), AC-23 (archived and deleted issues refused), E10, Q9 (200 KB) and Q12 (Markdown or
// JSON), the claim seam (SPEC-014 §4.3) for descriptions, and AC-7 (the optimistic rows equal the
// server's). The rules run on the in-memory workspace; the `issue_search_text` row and the version
// against Postgres are the held integration test (`issue-description.int.test.ts`, ⏸).
import { randomUUID } from 'node:crypto';
import { DESCRIPTION_MESSAGES, DOC_MAX_BYTES, EMPTY_DOC, type DocNodeJSON } from '@surface/domain';
import { DOC_MESSAGES } from '@surface/editor/schema';
import {
  issueCreate,
  issueUpdateDescription,
  type OptimisticStore,
  type StoreRow,
} from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { SurfaceError } from '../src/executor/errors.js';
import {
  createIssue,
  descriptionDoc,
  updateDescription,
  type CreateIssueInput,
  type IssueRow,
} from '../src/handlers/issues/core.js';
import { ADA_ID, memoryIssues, NOW, type MemoryIssues } from './support/memory-issues.js';

const EARLIER = new Date('2026-10-01T00:00:00.000Z');

async function failure(run: Promise<unknown>): Promise<SurfaceError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof SurfaceError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const paragraph = (text: string): DocNodeJSON => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function create(m: MemoryIssues, extra: Partial<CreateIssueInput> = {}): Promise<IssueRow> {
  return createIssue(m.ctx, {
    id: randomUUID(),
    team: m.eng,
    teamRef: 'ENG',
    title: 'Fix login',
    assigneeId: null,
    labelIds: [],
    estimate: null,
    dueDate: null,
    creatorId: ADA_ID,
    ...extra,
  });
}

function save(m: MemoryIssues, issue: IssueRow, baseVersion: number, doc: DocNodeJSON) {
  return updateDescription(m.ctx, { issueId: issue.id, baseVersion, description: doc });
}

/** A fresh workspace with one issue whose records are cleared. */
async function withIssue(extra: Partial<CreateIssueInput> = {}) {
  const m = memoryIssues();
  const issue = await create(m, extra);
  for (const list of [m.writes, m.events, m.calls, m.lockModes]) list.length = 0;
  return { m, issue };
}

describe('issue.create with a description (§3.1, §4.3)', () => {
  it('writes the Issue, then its IssueContent at version 1, then the created entry', async () => {
    const m = memoryIssues();
    const issue = await create(m, { description: paragraph('Steps to reproduce') });
    expect(m.writes.map((w) => [w.action, w.model ?? 'Issue'])).toEqual([
      ['insert', 'Issue'],
      ['insert', 'IssueContent'],
      ['insert', 'IssueHistory'],
    ]);
    expect(m.content.get(issue.id)).toMatchObject({
      id: issue.id,
      issueId: issue.id,
      teamId: issue.teamId,
      description: paragraph('Steps to reproduce'),
      version: 1,
    });
    expect(m.searchText.get(issue.id)).toBe('Steps to reproduce');
    expect(m.historyRows.at(-1)?.changes).toMatchObject({ description: true });
  });

  it('stores EMPTY_DOC when no description is given, with empty search text', async () => {
    const m = memoryIssues();
    const issue = await create(m);
    expect(m.content.get(issue.id)).toMatchObject({ description: EMPTY_DOC, version: 1 });
    expect(m.searchText.get(issue.id)).toBe('');
    expect(m.historyRows.at(-1)?.changes).not.toHaveProperty('description');
  });

  it('refuses a document with a /files/<uuid> reference through the claim seam, writing nothing', async () => {
    const m = memoryIssues();
    const doc: DocNodeJSON = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'file', attrs: { src: `/files/${randomUUID()}`, name: 'a.png' } }],
        },
      ],
    };
    const error = await failure(create(m, { description: descriptionDoc(doc) }));
    expect([error.code, error.message]).toEqual(['INVALID_INPUT', DOC_MESSAGES.badFile]);
    expect(error.details?.issues?.[0]?.path).toEqual(['description']);
    // The Issue insert is in the same transaction, which the executor rolls back.
    expect(m.writes.map((w) => w.model ?? 'Issue')).toEqual(['Issue']);
    expect(m.content.size).toBe(0);
  });
});

describe('descriptionDoc: Markdown or JSON, validated, at most 200 KB (Q9, Q12)', () => {
  it('converts Markdown to a document', () => {
    expect(descriptionDoc('Fix **this**')).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Fix ' },
            { type: 'text', text: 'this', marks: [{ type: 'bold' }] },
          ],
        },
      ],
    });
  });

  it('accepts an empty description', () => {
    expect(() => descriptionDoc(EMPTY_DOC)).not.toThrow();
    expect(() => descriptionDoc('')).not.toThrow();
  });

  it('refuses an invalid document with SPEC-013’s message and a path under description', () => {
    let error: unknown;
    try {
      descriptionDoc({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text' }] }],
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SurfaceError);
    const refusal = error as SurfaceError;
    expect(refusal.code).toBe('INVALID_INPUT');
    expect(refusal.details?.issues?.[0]?.path[0]).toBe('description');
  });

  it('refuses a document over 200 KB with the §6.4 message', () => {
    const big = paragraph('x'.repeat(DOC_MAX_BYTES.description));
    expect(() => descriptionDoc(big)).toThrow(DESCRIPTION_MESSAGES.tooLong);
  });

  it('the operation input caps Markdown at 200 KB before anything parses it', () => {
    const parse = (description: unknown) =>
      issueUpdateDescription.input.safeParse({ issue: 'ENG-1', baseVersion: 1, description });
    expect(parse('x'.repeat(DOC_MAX_BYTES.description)).success).toBe(true);
    const over = parse('x'.repeat(DOC_MAX_BYTES.description + 1));
    expect(over.error?.issues.map((i) => i.message)).toEqual([DESCRIPTION_MESSAGES.tooLong]);
    // Bytes, not characters: 'é' is two.
    expect(parse('é'.repeat(DOC_MAX_BYTES.description / 2 + 1)).success).toBe(false);
    expect(
      issueCreate.input.safeParse({
        team: 'ENG',
        title: 'T',
        description: 'x'.repeat(DOC_MAX_BYTES.description + 1),
      }).success,
    ).toBe(false);
  });
});

describe('issue.updateDescription (AC-6, E10)', () => {
  it('bumps the version and writes the search text with the content', async () => {
    const { m, issue } = await withIssue();
    const result = await save(m, issue, 1, paragraph('New text'));
    expect(result.version).toBe(2);
    expect(m.content.get(issue.id)).toMatchObject({
      description: paragraph('New text'),
      version: 2,
    });
    expect(m.searchText.get(issue.id)).toBe('New text');
    const again = await save(m, issue, 2, paragraph('Newer text'));
    expect(again.version).toBe(3);
    expect(m.searchText.get(issue.id)).toBe('Newer text');
  });

  it('refuses a stale baseVersion with CONFLICT, the §6.4 wording and no extra fields (D3)', async () => {
    const { m, issue } = await withIssue();
    await save(m, issue, 1, paragraph('First tab'));
    m.writes.length = 0;
    m.events.length = 0;
    const error = await failure(save(m, issue, 1, paragraph('Second tab')));
    expect([error.code, error.message]).toEqual(['CONFLICT', DESCRIPTION_MESSAGES.stale]);
    // No `currentVersion` or any other field: the client reads the version from its replica.
    expect(error.details).toEqual({});
    expect(m.writes).toEqual([]);
    expect(m.events).toEqual([]);
    expect(m.content.get(issue.id)?.version).toBe(2);
    expect(m.searchText.get(issue.id)).toBe('First tab');
  });

  it('checks the version after the issue lock, then claims, then writes', async () => {
    const { m, issue } = await withIssue();
    await save(m, issue, 1, paragraph('Text'));
    expect(m.calls.slice(0, 3)).toEqual(['lockIssue', 'readContent', 'claimFiles']);
    expect(m.lockModes).toEqual(['edit']);
  });

  it('moves the issue’s updatedAt and emits issue.updated when the text changes (§4.1)', async () => {
    const { m, issue } = await withIssue();
    m.issues.set(issue.id, { ...issue, updatedAt: EARLIER });
    await save(m, issue, 1, paragraph('Changed'));
    expect(m.issues.get(issue.id)?.updatedAt).toEqual(NOW);
    expect(m.events).toEqual([
      {
        type: 'issue.updated',
        subject: { type: 'issue', id: issue.id },
        data: { description: true, version: 2 },
      },
    ]);
  });

  it('a save of the same text bumps the version only: no history, no event, updatedAt kept', async () => {
    const { m, issue } = await withIssue({ description: paragraph('Same') });
    m.issues.set(issue.id, { ...issue, updatedAt: EARLIER });
    const entries = m.historyRows.length;
    const { version } = await save(m, issue, 1, paragraph('Same'));
    expect(version).toBe(2);
    expect(m.historyRows).toHaveLength(entries);
    expect(m.historyRows.at(-1)?.updatedAt).toEqual(NOW);
    expect(m.events).toEqual([]);
    expect(m.issues.get(issue.id)?.updatedAt).toEqual(EARLIER);
    expect(m.writes.map((w) => w.model ?? 'Issue')).toEqual(['IssueContent']);
  });

  it.each([
    ['archived', { archivedAt: EARLIER }, 'ENG-1 is archived. Restore it to edit it.'],
    [
      'deleted',
      { deletedAt: EARLIER, deletedById: ADA_ID },
      'ENG-1 was deleted. Restore it to edit it.',
    ],
  ] as const)(
    'refuses a %s issue with the §6.4 wording, even for the same text, writing nothing (AC-23)',
    async (_state, fields, message) => {
      const { m, issue } = await withIssue();
      m.issues.set(issue.id, { ...issue, ...fields });
      const error = await failure(save(m, issue, 1, EMPTY_DOC));
      expect([error.code, error.message]).toEqual(['CONFLICT', message]);
      expect(m.writes).toEqual([]);
      expect(m.calls).toEqual(['lockIssue']);
    },
  );

  it('refuses a document with a /files/<uuid> reference through the claim seam, writing nothing', async () => {
    const { m, issue } = await withIssue();
    const doc: DocNodeJSON = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'file', attrs: { src: `/files/${randomUUID()}`, name: 'a.pdf' } }],
        },
      ],
    };
    const error = await failure(save(m, issue, 1, doc));
    expect([error.code, error.message]).toEqual(['INVALID_INPUT', DOC_MESSAGES.badFile]);
    expect(error.details?.issues?.[0]?.path).toEqual(['description']);
    expect(m.writes).toEqual([]);
  });
});

// AC-7: the optimistic rows equal the server's (apart from history and search text, §6.2). The
// store holds the memory workspace's rows as the client does (ISO timestamps).

function clientRow(row: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
  );
}

function storeOf(m: MemoryIssues) {
  const rows: Record<string, Map<string, StoreRow>> = {
    Team: new Map([[m.eng.id, { ...m.eng, groups: ['workspace'] }]]),
    WorkflowStatus: new Map([...m.statuses].map(([id, s]) => [id, { ...s }])),
    Label: new Map(),
    User: new Map([[ADA_ID, { id: ADA_ID, name: 'Ada' }]]),
    Issue: new Map([...m.issues].map(([id, r]) => [id, { ...clientRow(r), groups: r.syncGroups }])),
    IssueContent: new Map([...m.content].map(([id, r]) => [id, clientRow(r)])),
  };
  const table = (model: string) => rows[model] ?? new Map<string, StoreRow>();
  const store: OptimisticStore = {
    now: NOW,
    get: (model, ref) =>
      model === 'User' && ref === 'me'
        ? table('User').get(ADA_ID)
        : [...table(model).values()].find((r) => r['id'] === ref || r['key'] === ref),
    find: (model, fields) =>
      [...table(model).values()].filter((r) =>
        Object.entries(fields).every(([f, v]) => r[f] === v),
      ),
    patch: (model, ref, changes) => {
      const row = table(model).get(ref);
      if (row) table(model).set(ref, { ...row, ...changes });
    },
    insert: (model, row) => void table(model).set(row.id, row),
    remove: () => undefined,
    archive: () => undefined,
    unarchive: () => undefined,
  };
  return { store, rows: table };
}

const comparableContent = (row: StoreRow | undefined) => {
  if (row === undefined) return undefined;
  const { syncGroups: _g, ...rest } = row;
  return rest;
};

describe('optimistic equals the server (AC-7)', () => {
  it('for issue.create with a description: the IssueContent at version 1', async () => {
    const m = memoryIssues();
    const { store, rows } = storeOf(m);
    const id = '0192f0c1-7e5a-7b3c-9d4e-' + randomUUID().slice(-12);
    const description = paragraph('Steps');
    const input = issueCreate.input.parse({ id, team: 'ENG', title: 'Fix login', description });
    issueCreate.optimistic?.(store, input);
    await create(m, { id, description });
    expect(comparableContent(rows('IssueContent').get(id))).toEqual(
      comparableContent(clientRow(m.content.get(id) ?? {})),
    );
  });

  it('for issue.updateDescription: the content and the issue’s updatedAt, changed or not', async () => {
    const { m, issue } = await withIssue({ description: paragraph('Old') });
    m.issues.set(issue.id, { ...issue, updatedAt: EARLIER });
    for (const [base, text] of [
      [1, 'New'],
      [2, 'New'],
      [3, 'Newer'],
    ] as const) {
      const { store, rows } = storeOf(m);
      const input = issueUpdateDescription.input.parse({
        issue: issue.id,
        baseVersion: base,
        description: paragraph(text),
      });
      issueUpdateDescription.optimistic?.(store, input);
      await save(m, issue, base, paragraph(text));
      expect(comparableContent(rows('IssueContent').get(issue.id))).toEqual(
        comparableContent(clientRow(m.content.get(issue.id) ?? {})),
      );
      expect(rows('Issue').get(issue.id)?.['updatedAt']).toEqual(
        m.issues.get(issue.id)?.updatedAt.toISOString(),
      );
    }
  });

  it('predicts nothing for a stale baseVersion or a Markdown description', async () => {
    const { m, issue } = await withIssue();
    const { store, rows } = storeOf(m);
    const before = rows('IssueContent').get(issue.id);
    for (const input of [
      { issue: issue.id, baseVersion: 7, description: paragraph('Stale') },
      { issue: issue.id, baseVersion: 1, description: 'Markdown' },
    ]) {
      issueUpdateDescription.optimistic?.(store, issueUpdateDescription.input.parse(input));
    }
    expect(rows('IssueContent').get(issue.id)).toBe(before);
  });
});
