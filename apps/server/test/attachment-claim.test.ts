// PLAN-014 S4b, SPEC-014 §4.3: saving a document claims, keeps or copies the files it references
// (`claimInlineFiles`), on an in-memory store (`support/memory-claims.ts`) with the real byte
// protocol (`insertCopies`): AC-8 (handler half), AC-21 (statement half), E7, E17, E19, E24, D1,
// D25. The SQL of the visibility read runs against Postgres in `attachment-leak.int.test.ts`.
// Replaces PLAN-011 S6's "the stub refuses any reference" test.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { systemActor, type Actor, type DocNodeJSON } from '@surface/domain';
import {
  DOC_MESSAGES,
  docFileIds,
  MAX_FILE_REFERENCES,
  renameFileSrcs,
} from '@surface/editor/schema';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { SurfaceError } from '../src/executor/errors.js';
import { FileBytesMissing } from '../src/files/bytes.js';
import { claimInlineFiles, planClaims } from '../src/files/claim.js';
import { documentFilesQuery, issueCopiesQuery, type DocumentFile } from '../src/files/store.js';
import { actorFor } from './helpers.js';
import { claimFileId, memoryClaims } from './support/memory-claims.js';

const ENG = '01940000-0000-7000-8000-0000000000e9';
const SEC = '01940000-0000-7000-8000-00000000005e';
const ADA = '01940000-0000-7000-8000-00000000ada1';
const BEN = '01940000-0000-7000-8000-000000000be1';
const ISSUE = '01940000-0000-7000-8000-0000000001a1';
const OTHER = '01940000-0000-7000-8000-0000000001a2';
const SECRET = '01940000-0000-7000-8000-0000000001a3';

/** Ada: a member of ENG (public), not of SEC (private). */
const ada: Actor = actorFor({
  id: ADA,
  memberships: [{ teamId: ENG, private: false }],
  publicTeams: [ENG],
});
const target = { id: ISSUE, teamId: ENG };

function world() {
  const w = memoryClaims();
  w.addIssue(ISSUE, ENG);
  w.addIssue(OTHER, ENG);
  w.addIssue(SECRET, SEC);
  return w;
}

const image = (id: string): DocNodeJSON => ({
  type: 'image',
  attrs: { src: `/files/${id}`, alt: 'Screenshot' },
});
const chip = (id: string): DocNodeJSON => ({
  type: 'file',
  attrs: { src: `/files/${id}`, name: 'report.pdf' },
});
const docOf = (...nodes: DocNodeJSON[]): DocNodeJSON => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'See below.' }] },
    ...nodes.map((node) => (node.type === 'file' ? { type: 'paragraph', content: [node] } : node)),
  ],
});

async function refusal(promise: Promise<unknown>): Promise<SurfaceError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof SurfaceError)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error;
}
const answer = (e: SurfaceError) => ({ code: e.code, message: e.message, details: e.details });

describe('claimInlineFiles (SPEC-014 §4.3, AC-8)', () => {
  it('returns a document without file references as is, reading nothing', async () => {
    const w = world();
    const doc = docOf();
    await expect(claimInlineFiles(w.store, doc, target, ada)).resolves.toBe(doc);
    expect(w.calls).toEqual([]);
  });

  it('claims the actor’s own unclaimed inline upload for the issue, leaving the document as it is', async () => {
    const w = world();
    const upload = await w.addFile({ id: claimFileId(), uploaderId: ADA });
    const doc = docOf(image(upload.id));
    await expect(claimInlineFiles(w.store, doc, target, ada)).resolves.toBe(doc);
    expect(w.rows.get(upload.id)?.issueId).toBe(ISSUE);
    // One conditional claim, no key lock and no new row (a claim inserts nothing).
    expect(w.calls).toEqual(['read', `claim ${upload.id}`, 'keys 0']);
  });

  it('keeps an inline file the issue already owns: no claim, no copy', async () => {
    const w = world();
    const owned = await w.addFile({ id: claimFileId(), uploaderId: BEN, issueId: ISSUE });
    const doc = docOf(image(owned.id), image(owned.id));
    await expect(claimInlineFiles(w.store, doc, target, ada)).resolves.toBe(doc);
    expect(w.calls).toEqual(['read']);
  });

  it('copies a visible attachment into a new inline row on the same bytes and rewrites every src (D1, E19)', async () => {
    const w = world();
    const attached = await w.addFile({
      id: claimFileId(),
      purpose: 'attachment',
      uploaderId: BEN,
      issueId: ISSUE,
      name: 'design.png',
      width: 1200,
      height: 800,
    });
    const doc = docOf(image(attached.id), chip(attached.id), image(attached.id));
    const saved = await claimInlineFiles(w.store, doc, target, ada);

    const [copyId] = docFileIds(saved);
    expect(docFileIds(saved)).toEqual([copyId]);
    expect(copyId).not.toBe(attached.id);
    expect(w.rows.get(copyId ?? '')).toEqual({
      ...attached,
      id: copyId,
      purpose: 'inline',
      issueId: ISSUE,
      detachedAt: null,
      previewOf: null,
    });
    // Everything but the src is kept: removing the attachment never breaks the document (E19).
    expect(saved).toEqual(renameFileSrcs(doc, new Map([[attached.id, copyId ?? '']])));
    expect(JSON.stringify(saved)).not.toContain(attached.id);
    // The source locked FOR SHARE, then the one key lock, then the row.
    expect(w.calls).toEqual([
      'read',
      'copies',
      `share ${attached.id}`,
      'keys 1',
      `insert ${copyId}`,
    ]);
  });

  it('names the copy an earlier save made instead of copying again, so autosaves add no rows', async () => {
    const w = world();
    const attached = await w.addFile({
      id: claimFileId(),
      purpose: 'attachment',
      uploaderId: BEN,
      issueId: OTHER,
      name: 'design.png',
    });
    const doc = docOf(image(attached.id));
    const first = await claimInlineFiles(w.store, doc, target, ada);
    const [copyId] = docFileIds(first);
    const rowsAfterFirst = w.rows.size;
    w.calls.length = 0;

    // The editor still holds the source's src and saves again (a later autosave).
    const second = await claimInlineFiles(w.store, doc, target, ada);
    expect(second).toEqual(first);
    expect(docFileIds(second)).toEqual([copyId]);
    expect(w.rows.size).toBe(rowsAfterFirst);
    // No lock, no insert: only the two reads.
    expect(w.calls).toEqual(['read', 'copies']);
  });

  it('copies again into another issue: a copy is reused only by the issue that holds it', async () => {
    const w = world();
    const attached = await w.addFile({
      id: claimFileId(),
      purpose: 'attachment',
      uploaderId: BEN,
      issueId: OTHER,
    });
    const doc = docOf(image(attached.id));
    const [inIssue] = docFileIds(await claimInlineFiles(w.store, doc, target, ada));
    const [inOther] = docFileIds(
      await claimInlineFiles(w.store, doc, { id: OTHER, teamId: ENG }, ada),
    );
    expect(inOther).not.toBe(inIssue);
    expect(w.rows.get(inOther ?? '')?.issueId).toBe(OTHER);
  });

  it('asks for held copies only once every reference is usable, so it adds no oracle', async () => {
    const w = world();
    const secret = await w.addFile({
      id: claimFileId(),
      purpose: 'attachment',
      uploaderId: BEN,
      issueId: SECRET,
    });
    // This issue even holds a copy of the SEC file's bytes (someone who sees SEC saved it here).
    await w.addFile({
      id: claimFileId(),
      uploaderId: BEN,
      issueId: ISSUE,
      storageKey: secret.storageKey,
      name: secret.name,
    });
    await refusal(claimInlineFiles(w.store, docOf(image(secret.id)), target, ada));
    expect(w.calls).toEqual(['read']);
  });

  it('copies an inline file of another issue (E7) and a preview of a visible attachment', async () => {
    const w = world();
    const elsewhere = await w.addFile({ id: claimFileId(), uploaderId: BEN, issueId: OTHER });
    const source = await w.addFile({
      id: claimFileId(),
      purpose: 'attachment',
      uploaderId: BEN,
      issueId: OTHER,
    });
    const preview = await w.addFile({
      id: claimFileId(),
      purpose: 'preview',
      uploaderId: BEN,
      previewOf: source.id,
      mimeType: 'image/webp',
    });
    const saved = await claimInlineFiles(
      w.store,
      docOf(image(elsewhere.id), image(preview.id)),
      target,
      ada,
    );
    const copies = docFileIds(saved).map((id) => w.rows.get(id));
    expect(copies).toEqual([
      expect.objectContaining({
        purpose: 'inline',
        issueId: ISSUE,
        storageKey: elsewhere.storageKey,
      }),
      expect.objectContaining({
        purpose: 'inline',
        issueId: ISSUE,
        storageKey: preview.storageKey,
        mimeType: 'image/webp',
        previewOf: null,
      }),
    ]);
  });

  it('claims, keeps and copies in one document: every row lock in id order, then one key lock', async () => {
    const w = world();
    // Ids ascend in creation order: copy source, claim, kept, copy source.
    const first = await w.addFile({ id: claimFileId(), uploaderId: BEN, issueId: OTHER });
    const upload = await w.addFile({ id: claimFileId(), uploaderId: ADA });
    const kept = await w.addFile({ id: claimFileId(), uploaderId: ADA, issueId: ISSUE });
    const last = await w.addFile({
      id: claimFileId(),
      purpose: 'attachment',
      uploaderId: BEN,
      issueId: OTHER,
    });
    const saved = await claimInlineFiles(
      w.store,
      docOf(image(last.id), image(kept.id), image(upload.id), image(first.id)),
      target,
      ada,
    );
    const [lastCopy, keptId, uploadId, firstCopy] = docFileIds(saved);
    expect([keptId, uploadId]).toEqual([kept.id, upload.id]);
    expect(w.calls).toEqual([
      'read',
      'copies',
      `share ${first.id}`,
      `claim ${upload.id}`,
      `share ${last.id}`,
      'keys 2',
      `insert ${lastCopy}`,
      `insert ${firstCopy}`,
    ]);
  });

  describe('one identical refusal for every file that can’t be used (AC-8, E17, permissions §5)', () => {
    async function refusals() {
      const w = world();
      const cases: Record<string, string> = {
        'an unknown id': randomUUID(),
        'someone else’s unclaimed inline upload': (
          await w.addFile({ id: claimFileId(), uploaderId: BEN })
        ).id,
        'the actor’s own unclaimed attachment upload': (
          await w.addFile({ id: claimFileId(), purpose: 'attachment', uploaderId: ADA })
        ).id,
        'a detached attachment of a visible issue': (
          await w.addFile({
            id: claimFileId(),
            purpose: 'attachment',
            uploaderId: ADA,
            issueId: ISSUE,
            detachedAt: new Date(),
          })
        ).id,
        'an attachment of a private team’s issue': (
          await w.addFile({
            id: claimFileId(),
            purpose: 'attachment',
            uploaderId: ADA,
            issueId: SECRET,
          })
        ).id,
        'an inline file of a private team’s issue, uploaded by the actor': (
          await w.addFile({ id: claimFileId(), uploaderId: ADA, issueId: SECRET })
        ).id,
        'an avatar': (await w.addFile({ id: claimFileId(), purpose: 'avatar', uploaderId: ADA }))
          .id,
        'a logo': (await w.addFile({ id: claimFileId(), purpose: 'logo', uploaderId: ADA })).id,
      };
      const secret = await w.addFile({
        id: claimFileId(),
        purpose: 'attachment',
        uploaderId: BEN,
        issueId: SECRET,
      });
      cases['a preview of a private team’s attachment'] = (
        await w.addFile({
          id: claimFileId(),
          purpose: 'preview',
          uploaderId: BEN,
          previewOf: secret.id,
        })
      ).id;
      // A usable upload in the same document: refusing must not claim it either.
      const usable = await w.addFile({ id: claimFileId(), uploaderId: ADA });
      const answers: Record<string, unknown> = {};
      for (const [label, id] of Object.entries(cases)) {
        const doc = docOf(image(usable.id), chip(id));
        answers[label] = answer(await refusal(claimInlineFiles(w.store, doc, target, ada)));
      }
      return { w, answers, usable };
    }

    it('answers each case exactly like an unknown id, INVALID_INPUT on the document’s field', async () => {
      const { answers } = await refusals();
      const message = DOC_MESSAGES.badFile;
      for (const [label, got] of Object.entries(answers)) {
        expect({ label, got }).toEqual({
          label,
          got: {
            code: 'INVALID_INPUT',
            message,
            details: { issues: [{ path: ['body'], message }] },
          },
        });
      }
    });

    it('claims, copies and locks nothing when any reference is unusable', async () => {
      const { w, usable } = await refusals();
      expect(w.rows.get(usable.id)?.issueId).toBeNull();
      expect(w.calls.filter((call) => call !== 'read')).toEqual([]);
    });

    it('names the issue description’s field when saving a description (PLAN-011 S6)', async () => {
      const w = world();
      const error = await refusal(
        claimInlineFiles(w.store, docOf(image(randomUUID())), target, ada, 'description'),
      );
      expect(error.details).toEqual({
        issues: [{ path: ['description'], message: DOC_MESSAGES.badFile }],
      });
    });

    it('refuses for the system actor, which has no files', async () => {
      const w = world();
      const upload = await w.addFile({ id: claimFileId(), uploaderId: ADA });
      const error = await refusal(
        claimInlineFiles(w.store, docOf(image(upload.id)), target, systemActor()),
      );
      expect(error.message).toBe(DOC_MESSAGES.badFile);
    });
  });

  describe('a key limited to some teams (E17, D25)', () => {
    const key = actorFor(
      {
        id: ADA,
        memberships: [
          { teamId: ENG, private: false },
          { teamId: SEC, private: true },
        ],
        publicTeams: [ENG],
      },
      {
        kind: 'api',
        apiKey: { id: 'k', scope: 'read_write', teamIds: [ENG], allowDestructive: false },
      },
    );

    it('refuses a file of a team outside the key, though the key’s owner sees it, like an unknown id', async () => {
      const w = world();
      const secret = await w.addFile({
        id: claimFileId(),
        purpose: 'attachment',
        uploaderId: BEN,
        issueId: SECRET,
      });
      const outside = answer(
        await refusal(claimInlineFiles(w.store, docOf(image(secret.id)), target, key)),
      );
      const unknown = answer(
        await refusal(claimInlineFiles(w.store, docOf(image(randomUUID())), target, key)),
      );
      expect(outside).toEqual(unknown);
      // The owner herself, without the key, may copy it.
      const ownerAda = actorFor({
        id: ADA,
        memberships: [
          { teamId: ENG, private: false },
          { teamId: SEC, private: true },
        ],
        publicTeams: [ENG],
      });
      await expect(
        claimInlineFiles(w.store, docOf(image(secret.id)), target, ownerAda),
      ).resolves.toBeDefined();
    });

    it('still claims the key owner’s own unclaimed inline upload: the uploader decides, not visibility', async () => {
      const w = world();
      const upload = await w.addFile({ id: claimFileId(), uploaderId: ADA });
      await claimInlineFiles(w.store, docOf(image(upload.id)), target, key);
      expect(w.rows.get(upload.id)?.issueId).toBe(ISSUE);
    });
  });

  describe('races with clean-up and purge (E24, AC-21)', () => {
    it('refuses the document when clean-up deleted the upload after it was read: the claim matches no row', async () => {
      const w = world();
      const upload = await w.addFile({ id: claimFileId(), uploaderId: ADA });
      w.deleteBeforeLock(upload.id);
      const error = await refusal(claimInlineFiles(w.store, docOf(image(upload.id)), target, ada));
      expect(error.message).toBe(DOC_MESSAGES.badFile);
      expect(w.calls).toEqual(['read', `claim ${upload.id}`]);
    });

    it('refuses the document, inserting nothing, when a copy’s source is gone at its lock', async () => {
      const w = world();
      const upload = await w.addFile({ id: claimFileId(), uploaderId: ADA });
      const source = await w.addFile({
        id: claimFileId(),
        purpose: 'attachment',
        uploaderId: BEN,
        issueId: OTHER,
      });
      w.deleteBeforeLock(source.id);
      const error = await refusal(
        claimInlineFiles(w.store, docOf(image(upload.id), image(source.id)), target, ada),
      );
      expect(error.message).toBe(DOC_MESSAGES.badFile);
      // The claim made before is rolled back with the transaction the refusal fails.
      expect(w.calls).toEqual(['read', 'copies', `claim ${upload.id}`, `share ${source.id}`]);
    });

    it('fails INTERNAL, logging the new file’s id only, when a copy’s bytes are missing', async () => {
      const w = world();
      const source = await w.addFile(
        {
          id: claimFileId(),
          purpose: 'attachment',
          uploaderId: BEN,
          issueId: OTHER,
          name: 'secret.png',
        },
        { bytes: false },
      );
      await expect(
        claimInlineFiles(w.store, docOf(image(source.id)), target, ada),
      ).rejects.toBeInstanceOf(FileBytesMissing);
      expect(w.logged.map((line) => line.message)).toEqual(['file bytes missing']);
      expect(Object.keys(w.logged[0]?.object ?? {})).toEqual(['fileId']);
      expect(JSON.stringify(w.logged)).not.toContain('secret.png');
    });
  });

  it(`refuses more than ${MAX_FILE_REFERENCES} distinct files with the schema’s message`, async () => {
    const w = world();
    const ids = Array.from({ length: MAX_FILE_REFERENCES + 1 }, () => randomUUID());
    const error = await refusal(claimInlineFiles(w.store, docOf(...ids.map(image)), target, ada));
    expect(error.message).toBe(DOC_MESSAGES.tooManyFiles);
    expect(w.calls).toEqual([]);
  });
});

describe('planClaims (§4.3’s table)', () => {
  const row = (fields: Partial<DocumentFile>): DocumentFile => ({
    id: 'f',
    purpose: 'inline',
    issueId: null,
    uploaderId: ADA,
    name: 'a.png',
    mimeType: 'image/png',
    size: 1,
    width: null,
    height: null,
    copyable: false,
    ...fields,
  });

  it('decides claim, keep, copy or nothing usable', () => {
    const plan = (r: DocumentFile) => planClaims(['f'], new Map([['f', r]]), ISSUE, ADA);
    expect(plan(row({}))).toEqual({ claims: ['f'], kept: [], copies: [] });
    expect(plan(row({ issueId: ISSUE }))).toEqual({ claims: [], kept: ['f'], copies: [] });
    const visible = row({ issueId: OTHER, copyable: true });
    expect(plan(visible)).toEqual({ claims: [], kept: [], copies: [visible] });
    expect(plan(row({ uploaderId: BEN }))).toBeUndefined();
    expect(plan(row({ issueId: OTHER }))).toBeUndefined();
    expect(plan(row({ purpose: 'attachment' }))).toBeUndefined();
    expect(planClaims(['f'], new Map(), ISSUE, ADA)).toBeUndefined();
  });
});

describe('the statements (AC-21)', () => {
  const dialect = new PgDialect();
  const compiled = (keyTeamIds: readonly string[] | null) => {
    const query = dialect.sqlToQuery(
      documentFilesQuery(['a', 'b'], { userId: ADA, groups: [`team:${ENG}`], keyTeamIds }),
    );
    return { text: query.sql.replace(/\s+/g, ' '), params: query.params };
  };

  it('reads every referenced file in one statement, copyable only through §4.2’s issue branch', () => {
    const { text, params } = compiled(null);
    expect(text).toContain('JOIN files s ON s.id = coalesce(f.preview_of, f.id)');
    expect(text).toContain('WHERE f.id = ANY(');
    expect(params).toContainEqual(['a', 'b']);
    expect(text).toContain("s.purpose IN ('attachment', 'inline') AND s.issue_id IS NOT NULL");
    expect(text).toContain('s.detached_at IS NULL');
    expect(text).toContain('i.sync_groups && ');
    // Never the uploader's branch, nor the avatar and logo rule.
    expect(text).not.toContain('s.uploader_id');
    expect(text).not.toContain('avatar');
    expect(text).not.toContain('i.team_id');
  });

  it('looks up held copies on the same bytes, name and type, inline rows of this issue only', () => {
    const query = dialect.sqlToQuery(issueCopiesQuery(ISSUE, ['a']));
    const text = query.sql.replace(/\s+/g, ' ');
    expect(text).toContain('c.storage_key = s.storage_key AND c.name = s.name');
    expect(text).toContain('c.mime_type = s.mime_type');
    expect(text).toContain("c.purpose = 'inline'");
    expect(query.params).toEqual([['a'], ISSUE]);
  });

  it('narrows the issue branch to a key’s teams', () => {
    const { text, params } = compiled([ENG]);
    expect(text).toContain('AND i.team_id = ANY(');
    expect(params).toContainEqual([ENG]);
  });

  it('keeps the file foreign keys RESTRICT: no SET NULL, no CASCADE', () => {
    // What Postgres holds: the migrations' constraints.
    const migrations = new URL('../migrations/', import.meta.url);
    const sql = [
      '0011_files_issue_columns.sql',
      '0012_avatar_logo_file_fks.sql',
      '0017_attachments.sql',
    ]
      .map((name) => readFileSync(new URL(name, migrations), 'utf8'))
      .join('\n');
    for (const fk of [
      'files_preview_of_files_id_fk',
      'users_avatar_file_id_files_id_fk',
      'workspace_logo_file_id_files_id_fk',
    ]) {
      expect(sql).toMatch(new RegExp(`${fk}[\\s\\S]*?ON DELETE restrict`, 'i'));
    }
    expect(sql).not.toMatch(/ON DELETE (set null|cascade)[^;]*"files"/i);
  });
});
