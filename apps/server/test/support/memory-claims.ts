/**
 * An in-memory `ClaimStore` (PLAN-014 S4b): `files` rows, the issues that own them, and a
 * `FileTx` that records the byte protocol's statements in order (`read` and `copies` for the two
 * reads). `documentFiles` applies the
 * SPEC-014 §4.2 issue branch in TypeScript (the SQL itself runs in `attachment-leak.int.test.ts`):
 * a claimed `attachment` or `inline` file, or a preview of one, not detached, whose issue's team
 * group the reader holds, within a key's teams.
 */
import { teamGroup } from '@surface/domain';
import type { FilePurpose } from '../../src/db/schema/files.js';
import { memoryBlobStore, type BlobStore } from '../../src/files/blob-store.js';
import type { FileTx, NewFile } from '../../src/files/bytes.js';
import type { ClaimStore } from '../../src/files/claim.js';
import type { DocumentFile, FileReader } from '../../src/files/store.js';

export interface MemoryFileRow {
  readonly id: string;
  readonly purpose: FilePurpose;
  issueId: string | null;
  readonly uploaderId: string;
  readonly detachedAt: Date | null;
  readonly storageKey: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly previewOf: string | null;
}

export interface MemoryClaims {
  readonly store: ClaimStore;
  readonly blobs: BlobStore;
  readonly rows: Map<string, MemoryFileRow>;
  /** Every statement the `FileTx` received, in order. */
  readonly calls: string[];
  /** Errors logged (`file bytes missing`). */
  readonly logged: { readonly object: object; readonly message: string }[];
  /** An issue of `teamId`, which owns files. */
  addIssue(issueId: string, teamId: string): void;
  /** A file row; its bytes are stored unless `bytes: false`. */
  addFile(
    fields: Partial<MemoryFileRow> & { readonly id: string },
    options?: { readonly bytes?: boolean },
  ): Promise<MemoryFileRow>;
  /** Clean-up deleting a row between the read and the claim (E24). */
  deleteBeforeLock(id: string): void;
}

let ids = 0;
/** Ascending UUIDv7-shaped ids for new rows. */
export function claimFileId(): string {
  ids++;
  return `0194b000-0000-7000-8000-${String(ids).padStart(12, '0')}`;
}

export function memoryClaims(): MemoryClaims {
  const rows = new Map<string, MemoryFileRow>();
  const issues = new Map<string, string>();
  const calls: string[] = [];
  const logged: { object: object; message: string }[] = [];
  const blobs = memoryBlobStore();
  const goneAtLock = new Set<string>();

  const seen = (issueId: string, reader: FileReader): boolean => {
    const teamId = issues.get(issueId);
    if (teamId === undefined || !reader.groups.includes(teamGroup(teamId))) return false;
    return reader.keyTeamIds === null || reader.keyTeamIds.includes(teamId);
  };
  const copyable = (row: MemoryFileRow, reader: FileReader): boolean => {
    const source = row.previewOf === null ? row : rows.get(row.previewOf);
    return (
      source !== undefined &&
      (source.purpose === 'attachment' || source.purpose === 'inline') &&
      source.issueId !== null &&
      source.detachedAt === null &&
      seen(source.issueId, reader)
    );
  };
  const dropGone = (id: string) => {
    if (goneAtLock.delete(id)) rows.delete(id);
  };

  const unexpected = () => Promise.reject(new Error('Not a statement a claim makes.'));
  const files: FileTx = {
    claimInline(id, issueId, uploaderId) {
      calls.push(`claim ${id}`);
      dropGone(id);
      const row = rows.get(id);
      if (
        row === undefined ||
        row.issueId !== null ||
        row.uploaderId !== uploaderId ||
        row.purpose !== 'inline'
      ) {
        return Promise.resolve(false);
      }
      row.issueId = issueId;
      return Promise.resolve(true);
    },
    lockFiles(fileIds, mode) {
      calls.push(`${mode} ${fileIds.join(',')}`);
      fileIds.forEach(dropGone);
      return Promise.resolve(
        fileIds.flatMap((id) => {
          const row = rows.get(id);
          return row === undefined ? [] : [{ id, storageKey: row.storageKey }];
        }),
      );
    },
    lockKeys(keys) {
      calls.push(`keys ${keys.length}`);
      return Promise.resolve();
    },
    insertFile(file: NewFile) {
      calls.push(`insert ${file.id}`);
      rows.set(file.id, {
        id: file.id,
        purpose: file.purpose,
        issueId: file.issueId ?? null,
        uploaderId: file.uploaderId,
        detachedAt: null,
        storageKey: file.storageKey,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        width: file.width ?? null,
        height: file.height ?? null,
        previewOf: file.previewOf ?? null,
      });
      return Promise.resolve();
    },
    lockPreviews: unexpected,
    deleteFiles: unexpected,
    releaseKeys: unexpected,
    keyInUse: unexpected,
    forgetKey: unexpected,
    cleanupCandidates: unexpected,
    savepoint: unexpected,
  };

  const store: ClaimStore = {
    documentFiles(fileIds, reader) {
      calls.push('read');
      const found: DocumentFile[] = [];
      for (const id of [...fileIds].sort()) {
        const row = rows.get(id);
        if (row === undefined) continue;
        const { name, mimeType, size, width, height, purpose, issueId, uploaderId } = row;
        found.push({
          id,
          purpose,
          issueId,
          uploaderId,
          name,
          mimeType,
          size,
          width,
          height,
          copyable: copyable(row, reader),
        });
      }
      return Promise.resolve(found);
    },
    issueCopies(issueId, sourceIds) {
      calls.push('copies');
      const held = new Map<string, string>();
      for (const sourceId of sourceIds) {
        const source = rows.get(sourceId);
        if (source === undefined) continue;
        const [copy] = [...rows.values()]
          .filter(
            (row) =>
              row.id !== sourceId &&
              row.issueId === issueId &&
              row.purpose === 'inline' &&
              row.storageKey === source.storageKey &&
              row.name === source.name &&
              row.mimeType === source.mimeType,
          )
          .map((row) => row.id)
          .sort();
        if (copy !== undefined) held.set(sourceId, copy);
      }
      return Promise.resolve(held);
    },
    files,
    blobs,
    log: { error: (object, message) => void logged.push({ object, message }) },
    newId: claimFileId,
  };

  return {
    store,
    blobs,
    rows,
    calls,
    logged,
    addIssue: (issueId, teamId) => void issues.set(issueId, teamId),
    async addFile(fields, options = {}) {
      const content = Buffer.from(`bytes of ${fields.id}`);
      const storageKey =
        options.bytes === false ? `sha256/00/00/${'0'.repeat(64)}` : await blobs.put(content);
      const row: MemoryFileRow = {
        purpose: 'inline',
        issueId: null,
        uploaderId: '',
        detachedAt: null,
        storageKey,
        name: 'screenshot.png',
        mimeType: 'image/png',
        size: content.length,
        width: 640,
        height: 480,
        previewOf: null,
        ...fields,
      };
      rows.set(row.id, row);
      return row;
    },
    deleteBeforeLock: (id) => void goneAtLock.add(id),
  };
}
