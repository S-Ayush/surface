/**
 * An in-memory `AttachmentAccess` and repo over `memoryIssues` (PLAN-014 S4a): Attachment rows and
 * the `files` rows they claim, with the issue lock, history and events of `m`. Each Attachment
 * write is recorded in `m.writes` (with its model) and `m.calls` (`write:<method>`), like an issue
 * write, so the lifecycle table test sees it.
 */
import type { FilePurpose } from '../../src/db/schema/files.js';
import type {
  AttachmentAccess,
  AttachmentRow,
  AttachmentWriteContext,
} from '../../src/handlers/attachment/core.js';
import { SurfaceError } from '../../src/executor/errors.js';
import type { Repo } from '../../src/sync/repo.js';
import { ADA_ID, type MemoryIssues } from './memory-issues.js';

export interface MemoryFile {
  readonly id: string;
  readonly purpose: FilePurpose;
  readonly uploaderId: string;
  issueId: string | null;
  detachedAt: Date | null;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly previewOf: string | null;
}

export interface MemoryAttachments {
  readonly rows: Map<string, AttachmentRow>;
  readonly files: Map<string, MemoryFile>;
  readonly repo: Repo;
  readonly access: AttachmentAccess;
  /** The context the attachment rules run with, as `m`'s actor at `m.now`. */
  ctx(): AttachmentWriteContext;
  addFile(fields: Partial<MemoryFile> & { readonly id: string }): MemoryFile;
  addAttachment(fields: Partial<AttachmentRow> & { readonly issueId: string }): AttachmentRow;
}

let counter = 0;
/** Ascending UUIDv7-shaped ids, so rows sort in creation order. */
export function attachmentId(): string {
  counter++;
  return `0193a000-0000-7000-8000-${String(counter).padStart(12, '0')}`;
}

export function memoryAttachments(m: MemoryIssues): MemoryAttachments {
  const rows = new Map<string, AttachmentRow>();
  const files = new Map<string, MemoryFile>();

  const teamOf = (issueId: string) => {
    const issue = m.issues.get(issueId);
    if (issue === undefined) throw new Error(`no issue ${issueId}`);
    return issue.teamId;
  };

  const write = (action: 'insert' | 'update' | 'purge', id: string, fields: string[]) => {
    m.calls.push(`write:${action}`);
    m.writes.push({ action, model: 'Attachment', ids: [id], fields });
  };

  const repo: Repo = {
    ...m.repo,
    insert(model, values) {
      if (model !== 'Attachment') return m.repo.insert(model, values);
      const given: Record<string, unknown> = { ...values };
      const teamId = teamOf(String(given['issueId']));
      const row = {
        ...(values as Omit<AttachmentRow, 'syncGroups' | 'createdAt' | 'updatedAt'>),
        // The repo sets a child's team and groups from its issue (SPEC-011 §5.1, §5.7).
        teamId,
        syncGroups: [`team:${teamId}`],
        createdAt: m.now,
        updatedAt: m.now,
      };
      rows.set(row.id, row);
      write('insert', row.id, Object.keys(values));
      return Promise.resolve(row as never);
    },
    update(model, id, patch) {
      if (model !== 'Attachment') return m.repo.update(model, id, patch);
      const row = rows.get(id);
      if (row === undefined) throw new SurfaceError('NOT_FOUND', 'not found');
      const next = { ...row, ...patch, updatedAt: m.now };
      rows.set(id, next);
      write('update', id, Object.keys(patch));
      return Promise.resolve(next as never);
    },
    purge(model, id) {
      if (model !== 'Attachment') return m.repo.purge(model, id);
      if (!rows.delete(id)) {
        return Promise.reject(new SurfaceError('NOT_FOUND', `${model} ${id} not found.`));
      }
      write('purge', id, []);
      return Promise.resolve();
    },
  };

  const access: AttachmentAccess = {
    lockIssue: (issueId, mode) => m.ctx.access.lockIssue(issueId, mode),
    countOnIssue(issueId) {
      m.calls.push('countOnIssue');
      return Promise.resolve([...rows.values()].filter((r) => r.issueId === issueId).length);
    },
    lockAttachment(id) {
      m.calls.push('lockAttachment');
      return Promise.resolve(rows.get(id));
    },
    claimFile(fileId, issueId, userId) {
      m.calls.push('claimFile');
      const file = files.get(fileId);
      const own = file?.issueId === null && file.uploaderId === userId;
      const undo = file?.issueId === issueId && file.detachedAt !== null;
      if (file === undefined || file.purpose !== 'attachment' || !(own || undo)) {
        return Promise.resolve(undefined);
      }
      file.issueId = issueId;
      file.detachedAt = null;
      const { id, name, mimeType, size, width, height } = file;
      return Promise.resolve({ id, name, mimeType, size, width, height });
    },
    detachFile(fileId, at) {
      m.calls.push('detachFile');
      const file = files.get(fileId);
      if (file !== undefined) file.detachedAt = at;
      return Promise.resolve();
    },
    isPreviewOf(fileId, sourceId) {
      const file = files.get(fileId);
      return Promise.resolve(file?.purpose === 'preview' && file.previewOf === sourceId);
    },
  };

  return {
    rows,
    files,
    repo,
    access,
    ctx() {
      const base = m.ctx;
      return {
        access,
        repo,
        history: { access: base.access, repo, actor: base.actor, now: base.now },
        emit: (event) => void m.events.push(event),
        now: base.now,
      };
    },
    addFile(fields) {
      const file: MemoryFile = {
        purpose: 'attachment',
        uploaderId: ADA_ID,
        issueId: null,
        detachedAt: null,
        name: 'screenshot.png',
        mimeType: 'image/png',
        size: 2048,
        width: 640,
        height: 480,
        previewOf: null,
        ...fields,
      };
      files.set(file.id, file);
      return file;
    },
    addAttachment(fields) {
      const teamId = teamOf(fields.issueId);
      const row: AttachmentRow = {
        id: attachmentId(),
        teamId,
        kind: 'link',
        title: 'Design doc',
        url: 'https://example.com/design',
        fileId: null,
        fileName: null,
        mimeType: null,
        size: null,
        imageWidth: null,
        imageHeight: null,
        previewFileId: null,
        creatorId: ADA_ID,
        syncGroups: [`team:${teamId}`],
        createdAt: m.now,
        updatedAt: m.now,
        ...fields,
      };
      rows.set(row.id, row);
      return row;
    },
  };
}
