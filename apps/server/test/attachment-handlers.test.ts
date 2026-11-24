// PLAN-014 S4a, SPEC-014 AC-7, AC-9, AC-10, E1: the attachment rules on in-memory issues and
// files (`support/memory-attachments.ts`). `createFile` takes only the actor's own unclaimed
// `attachment` upload or a detached file of the same issue, and copies the file's facts; links are
// http(s) only; 100 per issue; update and delete for the creator, team members and Admins, delete
// destructive and detaching the file; archived and deleted issues refuse every mutation but
// `setPreview`.
import { userActor, type ResolvedRefs } from '@surface/domain';
import {
  attachmentCreateFile,
  attachmentDelete,
  attachmentSetPreview,
  attachmentUpdate,
  evaluatePermission,
} from '@surface/operations';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SurfaceError } from '../src/executor/errors.js';
import {
  createFileAttachment,
  createLinkAttachment,
  creatorIdOf,
  deleteAttachment,
  renameAttachment,
  setAttachmentPreview,
  type AttachmentTarget,
} from '../src/handlers/attachment/core.js';
import type { IssueRow } from '../src/handlers/issues/core.js';
import { createIssue } from '../src/handlers/issues/core.js';
import { attachmentId, memoryAttachments } from './support/memory-attachments.js';
import { ADA_ID, memoryIssues, NOW, type MemoryIssues } from './support/memory-issues.js';

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
  // Past the 3-minute fold: each change writes its own entry.
  m.at(new Date(NOW.getTime() + 10 * 60 * 1000));
  for (const list of [m.writes, m.events, m.calls]) list.length = 0;
  const a = memoryAttachments(m);
  return { m, a, issue };
}

function state(m: MemoryIssues, issue: IssueRow, s: 'archived' | 'deleted') {
  m.issues.set(issue.id, {
    ...issue,
    ...(s === 'archived' ? { archivedAt: NOW } : { deletedAt: NOW, deletedById: ADA_ID }),
  });
}

const fileInput = (issueId: string, fileId: string, title?: string) => ({
  id: attachmentId(),
  issueId,
  fileRef: fileId,
  fileId,
  title,
  creatorId: ADA_ID,
});

async function refusal(promise: Promise<unknown>): Promise<SurfaceError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof SurfaceError))
    throw new Error(`expected a SurfaceError, got ${String(error)}`);
  return error;
}

const target = (row: { id: string; issueId: string }): AttachmentTarget => ({
  attachmentId: row.id,
  issueId: row.issueId,
  ref: row.id,
});

describe('attachment.createFile (AC-7)', () => {
  it('claims the actor’s own unclaimed upload and copies its name, type, size and dimensions', async () => {
    const { m, a, issue } = await world();
    const file = a.addFile({ id: attachmentId(), name: 'login.png', size: 4096 });
    const row = await createFileAttachment(a.ctx(), fileInput(issue.id, file.id));
    expect(row).toMatchObject({
      issueId: issue.id,
      teamId: issue.teamId,
      kind: 'file',
      title: 'login.png',
      url: null,
      fileId: file.id,
      fileName: 'login.png',
      mimeType: 'image/png',
      size: 4096,
      imageWidth: 640,
      imageHeight: 480,
      previewFileId: null,
      creatorId: ADA_ID,
    });
    expect(a.files.get(file.id)).toMatchObject({ issueId: issue.id, detachedAt: null });
    expect(m.events).toEqual([
      {
        type: 'attachment.created',
        subject: { type: 'attachment', id: row.id },
        data: { issueId: issue.id, kind: 'file' },
      },
    ]);
    // The lock first, then the limit under it, then the claim, then the row.
    expect(m.calls.slice(0, 4)).toEqual(['lockIssue', 'countOnIssue', 'claimFile', 'write:insert']);
    expect(m.lockModes).toEqual(['edit']);
  });

  it('keeps a typed title, trimmed', async () => {
    const { a, issue } = await world();
    const file = a.addFile({ id: attachmentId() });
    const row = await createFileAttachment(a.ctx(), fileInput(issue.id, file.id, '  Login  '));
    expect(row.title).toBe('Login');
  });

  it('re-attaches a detached file of the same issue and clears detached_at (the undo, §3.5)', async () => {
    const { a, issue } = await world();
    const file = a.addFile({ id: attachmentId(), issueId: issue.id, detachedAt: NOW });
    const row = await createFileAttachment(a.ctx(), fileInput(issue.id, file.id));
    expect(row.fileId).toBe(file.id);
    expect(a.files.get(file.id)?.detachedAt).toBeNull();
  });

  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])(
    'queues one preview job for a %s, after the row, in the same transaction (§4.4)',
    async (mimeType) => {
      const { m, a, issue } = await world();
      const file = a.addFile({ id: attachmentId(), mimeType });
      await createFileAttachment(a.ctx(), fileInput(issue.id, file.id));
      expect(m.calls.filter((call) => call.startsWith('enqueuePreview'))).toEqual([
        `enqueuePreview:${file.id}`,
      ]);
      expect(m.calls.indexOf(`enqueuePreview:${file.id}`)).toBeGreaterThan(
        m.calls.indexOf('write:insert'),
      );
    },
  );

  it('queues a preview job when re-attaching an image too: the job reuses the preview it made (S4a handoff)', async () => {
    const { m, a, issue } = await world();
    const file = a.addFile({ id: attachmentId(), issueId: issue.id, detachedAt: NOW });
    await createFileAttachment(a.ctx(), fileInput(issue.id, file.id));
    expect(m.calls).toContain(`enqueuePreview:${file.id}`);
  });

  it.each(['application/pdf', 'text/plain', 'application/octet-stream', 'image/svg+xml'])(
    'queues no preview for a %s',
    async (mimeType) => {
      const { m, a, issue } = await world();
      const file = a.addFile({ id: attachmentId(), mimeType, width: null, height: null });
      await createFileAttachment(a.ctx(), fileInput(issue.id, file.id));
      expect(m.calls.some((call) => call.startsWith('enqueuePreview'))).toBe(false);
    },
  );

  it('queues nothing when the claim is refused', async () => {
    const { m, a, issue } = await world();
    const file = a.addFile({ id: attachmentId(), uploaderId: IRIS_ID });
    await refusal(createFileAttachment(a.ctx(), fileInput(issue.id, file.id)));
    expect(m.calls.some((call) => call.startsWith('enqueuePreview'))).toBe(false);
  });

  it.each([
    ['someone else’s unclaimed upload', { uploaderId: IRIS_ID }],
    ['an inline upload', { purpose: 'inline' as const }],
    ['an attached file', { issueId: 'other' }],
    ['a file still attached to this issue', { issueId: 'SAME' }],
    ['a detached file of another issue', { issueId: 'other', detachedAt: NOW }],
    ['an avatar', { purpose: 'avatar' as const }],
  ])('refuses %s with NOT_FOUND on file, worded like an unknown id', async (_name, fields) => {
    const { m, a, issue } = await world();
    const id = attachmentId();
    const same = 'issueId' in fields && fields.issueId === 'SAME';
    a.addFile({ id, ...fields, ...(same ? { issueId: issue.id } : {}) });
    const error = await refusal(createFileAttachment(a.ctx(), fileInput(issue.id, id)));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe(
      `File "${id}" not found. That upload has expired or isn't yours. Upload the file again.`,
    );
    expect(error.details).toMatchObject({ issues: [{ path: ['file'] }] });
    const unknown = await refusal(
      createFileAttachment(a.ctx(), fileInput(issue.id, '0193a000-0000-7000-8000-ffffffffffff')),
    );
    expect(unknown.message).toBe(error.message.replace(id, '0193a000-0000-7000-8000-ffffffffffff'));
    expect(m.writes).toEqual([]);
    expect(m.events).toEqual([]);
  });

  it('refuses the 101st attachment with the §6.4 message; the upload stays unclaimed (E1)', async () => {
    const { m, a, issue } = await world();
    for (let n = 0; n < 100; n++) a.addAttachment({ issueId: issue.id });
    const file = a.addFile({ id: attachmentId() });
    const error = await refusal(createFileAttachment(a.ctx(), fileInput(issue.id, file.id)));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('An issue can have at most 100 attachments. Remove one first.');
    expect(error.details).toMatchObject({ issues: [{ path: ['issue'] }] });
    expect(a.files.get(file.id)?.issueId).toBeNull();
    expect(m.writes).toEqual([]);
  });

  it('allows the 100th attachment', async () => {
    const { a, issue } = await world();
    for (let n = 0; n < 99; n++) a.addAttachment({ issueId: issue.id });
    const file = a.addFile({ id: attachmentId() });
    await createFileAttachment(a.ctx(), fileInput(issue.id, file.id));
    expect([...a.rows.values()].filter((r) => r.issueId === issue.id)).toHaveLength(100);
  });
});

describe('attachment.createLink (AC-7, E11, E12)', () => {
  const link = (issueId: string, url: string, title?: string) => ({
    id: attachmentId(),
    issueId,
    url,
    title,
    creatorId: ADA_ID,
  });

  it('stores the URL with the default title, and a typed title when given', async () => {
    const { m, a, issue } = await world();
    const row = await createLinkAttachment(
      a.ctx(),
      link(issue.id, 'https://www.figma.com/file/abc123/Login-flow'),
    );
    expect(row).toMatchObject({
      kind: 'link',
      url: 'https://www.figma.com/file/abc123/Login-flow',
      fileId: null,
      size: null,
    });
    // The shared default (`defaultLinkTitle`), the same the client predicts (AC-17).
    expect(row.title).toBe('www.figma.com/file/abc123/Login-flow');
    const titled = await createLinkAttachment(
      a.ctx(),
      link(issue.id, 'https://status.example.com/incidents/42', 'Incident 42'),
    );
    expect(titled.title).toBe('Incident 42');
    expect(m.events.map((e) => e.type)).toEqual(['attachment.created', 'attachment.created']);
  });

  it.each([
    ['javascript:alert(1)', 'Use a web address that starts with https:// or http://.'],
    ['data:text/html,hi', 'Use a web address that starts with https:// or http://.'],
    ['https://ada:secret@example.com/', "Web addresses can't include a user name or password."],
  ])('refuses %s with INVALID_INPUT on url', async (url, message) => {
    const { m, a, issue } = await world();
    const error = await refusal(createLinkAttachment(a.ctx(), link(issue.id, url)));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe(message);
    expect(error.details).toMatchObject({ issues: [{ path: ['url'] }] });
    expect(m.writes).toEqual([]);
  });

  it('accepts a private address: the server never fetches it (E12)', async () => {
    const { a, issue } = await world();
    const row = await createLinkAttachment(a.ctx(), link(issue.id, 'http://10.0.0.5/admin'));
    expect(row.url).toBe('http://10.0.0.5/admin');
  });

  it('refuses the 101st attachment', async () => {
    const { a, issue } = await world();
    for (let n = 0; n < 100; n++) a.addAttachment({ issueId: issue.id });
    const error = await refusal(createLinkAttachment(a.ctx(), link(issue.id, 'https://a.example')));
    expect(error.message).toBe('An issue can have at most 100 attachments. Remove one first.');
  });
});

describe('attachment.update and attachment.delete', () => {
  it('renames, writes no history and no event, and writes nothing for the same title', async () => {
    const { m, a, issue } = await world();
    const row = a.addAttachment({ issueId: issue.id, title: 'Design doc' });
    const entries = m.historyRows.length;
    const renamed = await renameAttachment(a.ctx(), target(row), ' Login flow ');
    expect(renamed.title).toBe('Login flow');
    expect(m.historyRows).toHaveLength(entries);
    expect(m.events).toEqual([]);
    m.writes.length = 0;
    await renameAttachment(a.ctx(), target(renamed), 'Login flow');
    expect(m.writes).toEqual([]);
  });

  it('deletes the row and detaches its file at now, which stays for an undo (AC-9, E8)', async () => {
    const { m, a, issue } = await world();
    const file = a.addFile({ id: attachmentId(), issueId: issue.id });
    const row = a.addAttachment({ issueId: issue.id, kind: 'file', url: null, fileId: file.id });
    await deleteAttachment(a.ctx(), target(row));
    expect(a.rows.has(row.id)).toBe(false);
    expect(a.files.get(file.id)).toMatchObject({ issueId: issue.id, detachedAt: m.now });
    expect(m.events).toEqual([
      {
        type: 'attachment.deleted',
        subject: { type: 'attachment', id: row.id },
        data: { issueId: issue.id, kind: 'file' },
      },
    ]);
  });

  it('answers NOT_FOUND like an unknown id when the attachment went meanwhile', async () => {
    const { a, issue } = await world();
    const row = a.addAttachment({ issueId: issue.id });
    a.rows.delete(row.id);
    const error = await refusal(deleteAttachment(a.ctx(), target(row)));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe(
      `Attachment "${row.id}" not found. Use an attachment id from issue.get.`,
    );
  });
});

describe('who may rename and remove an attachment (AC-9)', () => {
  const TEAM = '0192f0c1-7e5a-7b3c-9d4e-00000000e000';
  const refs = (creatorId: string): ResolvedRefs => ({
    attachment: {
      id: 'a-1',
      issueId: 'i-1',
      teamId: TEAM,
      teamName: 'Engineering',
      creatorId,
    },
  });
  const member = userActor({ userId: IRIS_ID, role: 'member', memberships: [] });
  const teamMember = userActor({
    userId: IRIS_ID,
    role: 'member',
    memberships: [{ teamId: TEAM, private: false }],
  });
  const admin = userActor({ userId: IRIS_ID, role: 'admin', memberships: [] });

  it.each([attachmentUpdate, attachmentDelete])(
    '%#: allows the creator, a member of the issue’s team and an Admin; refuses others with a reason',
    (op) => {
      const input = { attachment: 'a-1', title: 'x' };
      expect(evaluatePermission(op, member, refs(IRIS_ID), input)).toEqual({ allowed: true });
      expect(evaluatePermission(op, teamMember, refs(ADA_ID), input)).toEqual({ allowed: true });
      expect(evaluatePermission(op, admin, refs(ADA_ID), input)).toEqual({ allowed: true });
      const refused = evaluatePermission(op, member, refs(ADA_ID), input);
      expect(refused.allowed).toBe(false);
      expect(refused.allowed === false && refused.reason).toMatch(
        /^Only .*members of Engineering.* can /,
      );
    },
  );

  it('flags delete destructive (a key without allowDestructive is refused by the executor)', () => {
    expect(attachmentDelete.destructive).toBe(true);
    expect(attachmentUpdate.destructive).toBe(false);
    expect(attachmentCreateFile.destructive).toBe(false);
  });

  it('marks setPreview systemOnly, with no menu entry: the executor hides it from everyone else', () => {
    expect(attachmentSetPreview.systemOnly).toBe(true);
    expect(attachmentSetPreview.ui).toBeUndefined();
  });

  it('refuses a system actor creating an attachment: it names no creator', () => {
    expect(() => creatorIdOf({ kind: 'system' })).toThrow(SurfaceError);
    expect(creatorIdOf({ kind: 'api', userId: ADA_ID })).toBe(ADA_ID);
  });
});

describe('archived and deleted issues (AC-10)', () => {
  it.each([
    ['archived', 'ENG-1 is archived. Restore it to edit it.'],
    ['deleted', 'ENG-1 was deleted. Restore it to edit it.'],
  ] as const)('refuses every user mutation on a %s issue, unchanged', async (s, message) => {
    const { m, a, issue } = await world();
    const file = a.addFile({ id: attachmentId() });
    const row = a.addAttachment({ issueId: issue.id });
    state(m, issue, s);
    const before = m.issues.get(issue.id);
    for (const attempt of [
      createFileAttachment(a.ctx(), fileInput(issue.id, file.id)),
      createLinkAttachment(a.ctx(), {
        id: attachmentId(),
        issueId: issue.id,
        url: 'https://a.example',
        title: undefined,
        creatorId: ADA_ID,
      }),
      renameAttachment(a.ctx(), target(row), 'New'),
      deleteAttachment(a.ctx(), target(row)),
    ]) {
      const error = await refusal(attempt);
      expect(error.code).toBe('CONFLICT');
      expect(error.message).toBe(message);
    }
    expect(m.writes).toEqual([]);
    expect(m.events).toEqual([]);
    expect(a.files.get(file.id)?.issueId).toBeNull();
    // Nothing is unarchived or restored.
    expect(m.issues.get(issue.id)).toEqual(before);
  });

  it.each(['archived', 'deleted'] as const)(
    'sets the preview on a %s issue, which stays as it was',
    async (s) => {
      const { m, a, issue } = await world();
      const file = a.addFile({ id: attachmentId(), issueId: issue.id });
      const preview = a.addFile({ id: attachmentId(), purpose: 'preview', previewOf: file.id });
      const row = a.addAttachment({ issueId: issue.id, kind: 'file', url: null, fileId: file.id });
      state(m, issue, s);
      const before = m.issues.get(issue.id);
      const entries = m.historyRows.length;
      const updated = await setAttachmentPreview(a.ctx(), target(row), preview.id);
      expect(updated.previewFileId).toBe(preview.id);
      expect(m.lockModes.at(-1)).toBe('cascade');
      expect(m.issues.get(issue.id)).toEqual(before);
      expect(m.events).toEqual([]);
      expect(m.historyRows).toHaveLength(entries);
    },
  );

  it('refuses a preview file that is not a preview of the attachment’s file', async () => {
    const { a, issue } = await world();
    const file = a.addFile({ id: attachmentId(), issueId: issue.id });
    const other = a.addFile({ id: attachmentId(), issueId: issue.id });
    const preview = a.addFile({ id: attachmentId(), purpose: 'preview', previewOf: other.id });
    const row = a.addAttachment({ issueId: issue.id, kind: 'file', url: null, fileId: file.id });
    const error = await refusal(setAttachmentPreview(a.ctx(), target(row), preview.id));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details).toMatchObject({ issues: [{ path: ['previewFile'] }] });
  });
});
