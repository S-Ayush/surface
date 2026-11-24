// PLAN-014 S4a, SPEC-015 AC-4 and AC-5 for attachments (SPEC-015 §4.5, SPEC-014 §4.5): purging an
// issue deletes its Attachment rows through the repo, one logged `D` each (the client drops them),
// then the issue's `files` rows through `deleteFiles`: previews before their source, every key in
// `blob_release`, no bytes unlinked inside the transaction.
import { describe, expect, it } from 'vitest';
import { insertPreview, insertUpload } from '../src/files/bytes.js';
import { ATTACHMENT_PURGE_STEPS, PURGE_STEPS } from '../src/issues/purge-steps.js';
import { body, ModelDb, modelBlobStore } from './files-bytes-model.js';
import { scriptedDb } from './support/scripted-db.js';

const ISSUE = '0190f0c0-0000-7000-8000-00000000a001';
const OTHER = '0190f0c0-0000-7000-8000-00000000a002';
const ADA = '0190f0c0-0000-7000-8000-0000000000ad';
const NOW = new Date('2026-11-16T10:00:00.000Z');
const id = (n: number) => `0190f0c0-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** The model's `files` rows: two attachments of ISSUE (one with a preview), one of OTHER. */
async function fileModel() {
  const db = new ModelDb();
  const blobs = modelBlobStore(db);
  const upload = async (fileId: string, issueId: string, content: string) => {
    const temp = await blobs.putStream(body(content));
    await db.transaction((tx) =>
      insertUpload(tx, blobs, temp, {
        id: fileId,
        purpose: 'attachment',
        name: 'x.png',
        mimeType: 'image/png',
        size: temp.size,
        uploaderId: ADA,
        issueId,
      }),
    );
  };
  await upload(id(1), ISSUE, 'one');
  await upload(id(2), ISSUE, 'shared');
  // Same bytes as id(2), on another issue: the key is released, and the drain keeps it (E2).
  await upload(id(3), OTHER, 'shared');
  const temp = await blobs.putStream(body('preview of one'));
  await db.transaction((tx) =>
    insertPreview(tx, blobs, temp, {
      id: id(4),
      purpose: 'preview',
      name: 'preview.webp',
      mimeType: 'image/webp',
      size: temp.size,
      uploaderId: ADA,
      previewOf: id(1),
    }),
  );
  return { db, blobs };
}

const attachment = (n: number, issueId: string) => ({
  id: id(100 + n),
  issue_id: issueId,
  team_id: 'team-eng',
  sync_groups: ['team:team-eng'],
});

describe('the attachment purge steps (SPEC-015 §4.5)', () => {
  it('are registered after the comment steps and before history and content', () => {
    expect(ATTACHMENT_PURGE_STEPS.map((s) => s.model)).toEqual(['Attachment', 'table:files']);
    const models = PURGE_STEPS.map((s) => s.model);
    expect(models.indexOf('Attachment')).toBeGreaterThan(models.indexOf('Comment'));
    expect(models.indexOf('table:files')).toBeGreaterThan(models.indexOf('Attachment'));
    expect(models.indexOf('table:files')).toBeLessThan(models.indexOf('IssueHistory'));
  });

  it('delete the issue’s attachments with one logged D each, and only the issue’s', async () => {
    const { db, repo, rowsOf } = scriptedDb(
      {
        attachments: [attachment(1, ISSUE), attachment(2, ISSUE), attachment(3, OTHER)],
        files: [],
      },
      { now: NOW },
    );
    const model = await fileModel();
    const step = ATTACHMENT_PURGE_STEPS[0];
    if (step === undefined) throw new Error('no attachment step');
    await model.db.modelTransaction((tx) => step.step(db, repo, ISSUE, tx));
    expect([...rowsOf('attachments').keys()]).toEqual([id(103)]);
    expect(repo.changes().map((c) => [c.model, c.action, c.id])).toEqual([
      ['Attachment', 'D', id(101)],
      ['Attachment', 'D', id(102)],
    ]);
  });

  it('delete the issue’s files and their previews, releasing every key, unlinking nothing', async () => {
    const { db, repo } = scriptedDb(
      {
        files: [
          { id: id(1), issue_id: ISSUE },
          { id: id(2), issue_id: ISSUE },
          { id: id(3), issue_id: OTHER },
        ],
      },
      { now: NOW },
    );
    const model = await fileModel();
    const keyOf = (fileId: string) => model.db.rows.get(fileId)?.storageKey;
    const keys = [keyOf(id(1)), keyOf(id(2)), keyOf(id(4))];
    const before = model.blobs.keys().length;
    const step = ATTACHMENT_PURGE_STEPS[1];
    if (step === undefined) throw new Error('no files step');
    await model.db.modelTransaction((tx) => step.step(db, repo, ISSUE, tx));
    expect([...model.db.rows.keys()]).toEqual([id(3)]);
    expect([...model.db.released].sort()).toEqual([...keys].sort());
    // The bytes go only when the drain runs after commit (SPEC-015 AC-5).
    expect(model.blobs.keys()).toHaveLength(before);
    expect(repo.changes()).toEqual([]);
  });

  it('do nothing for an issue with no attachments or files', async () => {
    const { db, repo } = scriptedDb({ attachments: [], files: [] }, { now: NOW });
    const model = await fileModel();
    for (const step of ATTACHMENT_PURGE_STEPS) {
      await model.db.modelTransaction((tx) => step.step(db, repo, id(999), tx));
    }
    expect(model.db.rows.size).toBe(4);
    expect(model.db.released.size).toBe(0);
    expect(repo.changes()).toEqual([]);
  });
});
