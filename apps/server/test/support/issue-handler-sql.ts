/**
 * Runs an issue-writing operation's registered handler on SQL (PLAN-015 S1, moved here in PLAN-011
 * S8 so the lifecycle table test and the lock-order test share it): ENG-1 in a given lifecycle
 * state, a connection that records each statement and answers a plain select with one fixture row
 * per table, and a repo that records each write in the same list (`repo.<method>`).
 */
import { randomUUID } from 'node:crypto';
import { NEW_TEAM_SETTINGS, type Actor, type IssueLifecycle } from '@surface/domain';
import type { HandlerContext } from '../../src/executor/context.js';
import { HANDLERS } from '../../src/handlers/index.js';
import { createIssue, type IssueRow } from '../../src/handlers/issues/core.js';
import { ADA_ID, memoryIssues, NOW, type MemoryIssues } from './memory-issues.js';
import { recordingDb, type Statement } from './scripted-db.js';

export const EARLIER = new Date('2026-10-01T00:00:00.000Z');
export const DELETED_AT = new Date(NOW.getTime() - 60 * 60 * 1000);

/** ENG-1 in `state`, with the workspace's records cleared and every repo write logged in `calls`. */
export async function issueIn(
  state: IssueLifecycle,
): Promise<{ m: MemoryIssues; issue: IssueRow }> {
  const m = memoryIssues();
  const created = await createIssue(m.ctx, {
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
  const issue: IssueRow = {
    ...created,
    archivedAt: state === 'archived' ? EARLIER : null,
    deletedAt: state === 'deleted' ? DELETED_AT : null,
    deletedById: state === 'deleted' ? ADA_ID : null,
    updatedAt: EARLIER,
  };
  m.issues.set(issue.id, issue);
  for (const list of [m.writes, m.events, m.calls, m.lockModes, m.history, m.audits]) {
    list.length = 0;
  }
  // Every write lands in `calls` too, so a test can see that the lock came first.
  const repo = m.repo as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of [
    'insert',
    'update',
    'archive',
    'unarchive',
    'updateWhere',
    'purge',
    'deleteWhere',
  ]) {
    const original = repo[name];
    if (typeof original !== 'function') continue;
    repo[name] = (...args: unknown[]) => {
      m.calls.push(`write:${name}`);
      return original(...args);
    };
  }
  return { m, issue };
}

/** The comment the comment handlers' inputs name, a top-level comment on ENG-1 by Ada. */
export const COMMENT_ID = '0190f0c0-0000-7000-8000-0000000000c1';
/** The label `label.delete` names, an ENG label that ENG-1 carries. */
export const LABEL_ID = '0190f0c0-0000-7000-8000-0000000000b1';
/** A file attachment on ENG-1, and the upload `attachment.createFile` names (PLAN-014 S4a). */
export const ATTACHMENT_ID = '0190f0c0-0000-7000-8000-0000000000a1';
export const FILE_ID = '0190f0c0-0000-7000-8000-0000000000f1';
export const PREVIEW_ID = '0190f0c0-0000-7000-8000-0000000000f2';

/** The input each built operation's registered handler runs with on ENG-1. */
export const HANDLER_INPUTS: Readonly<Record<string, Record<string, unknown>>> = {
  'issue.update': { issue: 'ENG-1', title: 'Fix the login' },
  'issue.updateDescription': { issue: 'ENG-1', baseVersion: 1, description: 'Steps to reproduce' },
  'issue.delete': { issue: 'ENG-1' },
  'issue.restore': { issue: 'ENG-1' },
  'issue.purge': { issue: 'ENG-1' },
  'comment.create': { issue: 'ENG-1', body: 'Looks good' },
  'comment.update': { comment: COMMENT_ID, baseVersion: 1, body: 'Looks good' },
  'comment.delete': { comment: COMMENT_ID },
  'comment.resolve': { comment: COMMENT_ID },
  'comment.reopen': { comment: COMMENT_ID },
  'reaction.set': { comment: COMMENT_ID, emoji: '👍', reacted: true },
  'label.delete': { label: LABEL_ID },
  'attachment.createFile': { issue: 'ENG-1', file: FILE_ID },
  'attachment.createLink': { issue: 'ENG-1', url: 'https://example.com/spec' },
  'attachment.update': { attachment: ATTACHMENT_ID, title: 'Login spec' },
  'attachment.delete': { attachment: ATTACHMENT_ID },
  'attachment.setPreview': { attachment: ATTACHMENT_ID, previewFile: PREVIEW_ID },
};

/**
 * The jobs' operations read the team's settings and a status `FOR SHARE` before the issue lock
 * (SPEC-011 §4.8), and a scripted row per table can't answer both a status's category and the
 * Canceled one: `automations-handlers.test.ts` runs their handlers on SQL with its own script.
 */
export const OWN_SQL_TEST = new Set(['issue.autoArchive', 'issue.autoClose']);

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const snakeRow = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [snake(key), value]));

/**
 * Answers a plain `select "a", "b" from "table" …` with the fixture row of `table`, in the
 * selected columns' order; anything else gets no rows.
 */
export function answerFrom(tables: Readonly<Record<string, Record<string, unknown>>>) {
  return (text: string): unknown[][] => {
    const match = /^select (.+?) from "(\w+)"/.exec(text);
    const row = match?.[2] === undefined ? undefined : tables[match[2]];
    if (match?.[1] === undefined || row === undefined) return [];
    const columns = match[1].split(', ').map((column) => column.replace(/^.*"(\w+)"$/, '$1'));
    return [columns.map((column) => row[column] ?? null)];
  };
}

/**
 * Runs `name`'s registered handler on ENG-1 in `state`, over a connection that records its SQL
 * and a repo that records each write in the same list (as `repo.<method>`).
 */
export async function runHandler(name: string, state: IssueLifecycle): Promise<Statement[]> {
  const { m, issue } = await issueIn(state);
  const found = HANDLERS.find((h) => h.op.name === name);
  if (found === undefined) throw new Error(`no handler for ${name}`);
  const team = { ...NEW_TEAM_SETTINGS, ...m.eng, defaultStatusId: issue.statusId };
  const { db, statements } = recordingDb(
    answerFrom({
      issues: snakeRow({ ...issue, labelIds: [LABEL_ID] }),
      teams: snakeRow(team),
      labels: snakeRow({
        id: LABEL_ID,
        teamId: issue.teamId,
        name: 'Flaky',
        color: 'red',
        description: null,
        parentId: null,
        isGroup: false,
        exclusive: true,
        archivedAt: null,
        syncGroups: [`team:${issue.teamId}`],
        createdAt: EARLIER,
        updatedAt: EARLIER,
      }),
      workflow_statuses: { id: issue.statusId, name: 'Backlog', category: 'backlog' },
      users: { id: ADA_ID, name: 'Ada' },
      issue_content: { description: { type: 'doc', content: [{ type: 'paragraph' }] }, version: 1 },
      attachments: snakeRow({
        id: ATTACHMENT_ID,
        issueId: issue.id,
        teamId: issue.teamId,
        kind: 'file',
        title: 'notes.txt',
        url: null,
        fileId: FILE_ID,
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        size: 5,
        imageWidth: null,
        imageHeight: null,
        previewFileId: null,
        creatorId: ADA_ID,
        syncGroups: [`team:${issue.teamId}`],
        createdAt: EARLIER,
        updatedAt: EARLIER,
      }),
      comments: snakeRow({
        id: COMMENT_ID,
        issueId: issue.id,
        teamId: issue.teamId,
        parentCommentId: null,
        userId: ADA_ID,
        actorKind: 'user',
        body: { type: 'doc', content: [{ type: 'paragraph' }] },
        version: 1,
        editedAt: null,
        deletedAt: null,
        resolvedAt: null,
        resolvedById: null,
        syncGroups: [`team:${issue.teamId}`],
        createdAt: EARLIER,
        updatedAt: EARLIER,
      }),
    }),
  );
  let current: IssueRow = issue;
  const write = (method: string, patch: Partial<IssueRow> = {}) => {
    statements.push({ text: `repo.${method}`, params: [] });
    current = { ...current, ...patch };
    return Promise.resolve(current);
  };
  const repo = {
    update: (_model: string, _id: string, patch: Partial<IssueRow>) => write('update', patch),
    archive: () => write('archive', { archivedAt: NOW }),
    unarchive: () => write('unarchive', { archivedAt: null }),
    updateWhere: () => write('updateWhere').then(() => []),
    insert: () => write('insert'),
    purge: () => write('purge'),
    deleteWhere: () => write('deleteWhere').then(() => []),
  };
  const actor: Actor = {
    kind: 'user',
    userId: ADA_ID,
    groups: ['workspace', `user:${ADA_ID}`],
    publicTeams: [issue.teamId],
    memberOf: [issue.teamId],
  };
  // Only what these handlers touch; the executor resolved the `IssueRef` (step 7).
  const ctx = {
    actor,
    tx: db,
    repo,
    refs: {
      issue: { id: issue.id, teamId: issue.teamId, key: 'ENG-1' },
      comment: { id: COMMENT_ID, issueId: issue.id, teamId: issue.teamId, parentCommentId: null },
      label: { id: LABEL_ID, teamId: issue.teamId, name: 'Flaky' },
      attachment: { id: ATTACHMENT_ID, issueId: issue.id, teamId: issue.teamId },
      file: { id: FILE_ID },
    },
    now: () => NOW,
    emit: () => undefined,
    audit: () => undefined,
    publicUrl: 'https://surface.test',
  } as unknown as HandlerContext;
  const input = found.op.input.parse(HANDLER_INPUTS[name]);
  // A refusal or a no-op is part of the row; only the order of statements is checked here.
  await found.run(ctx, input).catch(() => undefined);
  return statements;
}
