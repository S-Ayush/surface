// PLAN-014 S4a, SPEC-014 §6.2 "Optimistic", AC-17, AC-18: each attachment mutation predicts the
// row the server commits (apart from `createdAt`, `updatedAt` and `previewFileId`), refuses at once
// an issue the store shows archived or deleted with the server's message, and predicts nothing
// for an issue the store doesn't hold; the operations pass the registry lint and `setPreview` is
// hidden from every surface. The seed examples run in server/test/registry-contract.int.test.ts.
import { describe, expect, it } from 'vitest';
import { isPublicOperation } from '../catalog.js';
import { lintOperations } from '../lint.js';
import { OptimisticRefusal, type OptimisticStore, type StoreRow } from '../optimistic.js';
import {
  attachmentCreateFile,
  attachmentCreateLink,
  attachmentDelete,
  attachmentSetPreview,
  attachmentUpdate,
} from './attachment.js';
import { ALL_OPERATIONS } from './index.js';
import { UI_CONTEXTS } from '../ui.js';

const ISSUE = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
const TEAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const ME = '0192f0c1-7e5a-7b3c-9d4e-0000000000ad';
const IRIS = '0192f0c1-7e5a-7b3c-9d4e-0000000001e1';
const NEW_ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000a9';
const FILE = '0192f0c1-7e5a-7b3c-9d4e-0000000000f1';
const NOW = new Date('2026-11-16T10:00:00.000Z');
const AT = NOW.toISOString();

interface World {
  readonly issue?: StoreRow | undefined;
  readonly attachments?: readonly StoreRow[];
  readonly member?: boolean;
  readonly role?: 'admin' | 'member';
}

/** A store holding ENG-42 (unless `issue` is undefined), its team, the actor and attachments. */
function fakeStore(world: World = {}) {
  const issue =
    'issue' in world
      ? world.issue
      : { id: ISSUE, teamId: TEAM, number: 42, archivedAt: null, deletedAt: null };
  const attachments = new Map((world.attachments ?? []).map((row) => [String(row['id']), row]));
  const writes: unknown[][] = [];
  const store: OptimisticStore = {
    now: NOW,
    get(model, ref) {
      if (model === 'Issue') return ref === ISSUE || ref === 'ENG-42' ? issue : undefined;
      if (model === 'Team') return ref === TEAM ? { id: TEAM, key: 'ENG' } : undefined;
      if (model === 'User')
        return ref === 'me' ? { id: ME, role: world.role ?? 'member' } : undefined;
      if (model === 'Attachment') return attachments.get(ref);
      return undefined;
    },
    find(model, fields) {
      if (model === 'Attachment') {
        return [...attachments.values()].filter((row) => row['issueId'] === fields['issueId']);
      }
      if (model === 'TeamMembership' && world.member === true) {
        return fields['teamId'] === TEAM && fields['userId'] === ME ? [{ id: 'm-1' }] : [];
      }
      return [];
    },
    patch: (model, ref, changes) => void writes.push(['patch', model, ref, changes]),
    insert: (model, row) => void writes.push(['insert', model, row]),
    archive: (model, ref) => void writes.push(['archive', model, ref]),
    unarchive: (model, ref) => void writes.push(['unarchive', model, ref]),
    remove: (model, ref) => void writes.push(['remove', model, ref]),
  };
  return { store, writes };
}

/** An attachment row as the store holds it (what the server committed). */
const held = (fields: Partial<StoreRow> = {}): StoreRow => ({
  id: '0192f0c1-7e5a-7b3c-9d4e-000000000a01',
  issueId: ISSUE,
  teamId: TEAM,
  kind: 'link',
  title: 'Login flow',
  url: 'https://www.figma.com/file/abc123/Login-flow',
  fileId: null,
  fileName: null,
  mimeType: null,
  size: null,
  imageWidth: null,
  imageHeight: null,
  previewFileId: null,
  creatorId: ME,
  groups: [`team:${TEAM}`],
  createdAt: AT,
  updatedAt: AT,
  ...fields,
});

const hundred = Array.from({ length: 100 }, (_, n) =>
  held({ id: `0192f0c1-7e5a-7b3c-9d4e-${String(n).padStart(12, '0')}` }),
);

describe('attachment.createLink optimistic (AC-17)', () => {
  it('inserts the row the server commits, with the shared default title', () => {
    const { store, writes } = fakeStore();
    attachmentCreateLink.optimistic?.(store, {
      id: NEW_ID,
      issue: 'ENG-42',
      url: 'https://status.example.com/incidents/42',
    });
    expect(writes).toEqual([
      [
        'insert',
        'Attachment',
        held({
          id: NEW_ID,
          title: 'status.example.com/incidents/42',
          url: 'https://status.example.com/incidents/42',
        }),
      ],
    ]);
  });

  it('stores the URL as the parser writes it, and a typed title normalised', () => {
    const { store, writes } = fakeStore();
    attachmentCreateLink.optimistic?.(store, {
      id: NEW_ID,
      issue: ISSUE,
      url: 'HTTPS://Example.COM',
      title: '  Home\npage ',
    });
    expect(writes[0]?.[2]).toMatchObject({ url: 'https://example.com/', title: 'Home page' });
  });

  it('predicts nothing at the 100 limit: the server refuses', () => {
    const { store, writes } = fakeStore({ attachments: hundred });
    attachmentCreateLink.optimistic?.(store, { id: NEW_ID, issue: ISSUE, url: 'https://a.test' });
    expect(writes).toEqual([]);
  });
});

describe('attachment.createFile optimistic (AC-17)', () => {
  const upload = { name: 'login.png', mimeType: 'image/png', size: 4096, width: 640, height: 480 };

  it('inserts the row from the upload answer, title defaulting to the file name', () => {
    const { store, writes } = fakeStore();
    attachmentCreateFile.optimistic?.(store, { id: NEW_ID, issue: ISSUE, file: FILE, upload });
    expect(writes).toEqual([
      [
        'insert',
        'Attachment',
        held({
          id: NEW_ID,
          kind: 'file',
          title: 'login.png',
          url: null,
          fileId: FILE,
          fileName: 'login.png',
          mimeType: 'image/png',
          size: 4096,
          imageWidth: 640,
          imageHeight: 480,
        }),
      ],
    ]);
  });

  it('predicts nothing without the upload answer (an undo, or an API caller)', () => {
    const { store, writes } = fakeStore();
    attachmentCreateFile.optimistic?.(store, { id: NEW_ID, issue: ISSUE, file: FILE });
    expect(writes).toEqual([]);
  });
});

describe('attachment.update and attachment.delete optimistic (AC-17)', () => {
  it('renames and removes the creator’s own attachment', () => {
    const row = held();
    const { store, writes } = fakeStore({ attachments: [row] });
    attachmentUpdate.optimistic?.(store, { attachment: String(row['id']), title: ' Flow ' });
    attachmentDelete.optimistic?.(store, { attachment: String(row['id']) });
    expect(writes).toEqual([
      ['patch', 'Attachment', row['id'], { title: 'Flow', updatedAt: AT }],
      ['remove', 'Attachment', row['id']],
    ]);
  });

  it('lets a team member and an Admin change someone else’s attachment', () => {
    const row = held({ creatorId: IRIS });
    for (const world of [{ member: true }, { role: 'admin' as const }]) {
      const { store, writes } = fakeStore({ attachments: [row], ...world });
      attachmentDelete.optimistic?.(store, { attachment: String(row['id']) });
      expect(writes).toEqual([['remove', 'Attachment', row['id']]]);
    }
  });

  it('predicts nothing for anyone else: the server refuses', () => {
    const row = held({ creatorId: IRIS });
    const { store, writes } = fakeStore({ attachments: [row] });
    attachmentUpdate.optimistic?.(store, { attachment: String(row['id']), title: 'x' });
    attachmentDelete.optimistic?.(store, { attachment: String(row['id']) });
    expect(writes).toEqual([]);
  });
});

describe('the lifecycle of the issue in the store (AC-17, §6.2)', () => {
  const issue = (fields: StoreRow) => ({
    id: ISSUE,
    teamId: TEAM,
    number: 42,
    archivedAt: null,
    deletedAt: null,
    ...fields,
  });

  it.each([
    ['archived', { archivedAt: AT }, 'ENG-42 is archived. Restore it to edit it.'],
    ['deleted', { deletedAt: AT }, 'ENG-42 was deleted. Restore it to edit it.'],
  ] as const)(
    'refuses every mutation on a %s issue with the server’s message',
    (_s, f, message) => {
      const row = held();
      const { store, writes } = fakeStore({ issue: issue(f), attachments: [row] });
      const attempts = [
        () =>
          attachmentCreateLink.optimistic?.(store, {
            id: NEW_ID,
            issue: ISSUE,
            url: 'https://a.test',
          }),
        () =>
          attachmentCreateFile.optimistic?.(store, {
            id: NEW_ID,
            issue: ISSUE,
            file: FILE,
            upload: { name: 'a.txt', mimeType: 'text/plain', size: 1 },
          }),
        () => attachmentUpdate.optimistic?.(store, { attachment: String(row['id']), title: 'x' }),
        () => attachmentDelete.optimistic?.(store, { attachment: String(row['id']) }),
      ];
      for (const attempt of attempts) {
        expect(attempt).toThrow(OptimisticRefusal);
        expect(attempt).toThrow(message);
      }
      expect(writes).toEqual([]);
    },
  );

  it('predicts nothing for an issue the store doesn’t hold: the server decides', () => {
    const { store, writes } = fakeStore({ issue: undefined });
    attachmentCreateLink.optimistic?.(store, { id: NEW_ID, issue: ISSUE, url: 'https://a.test' });
    attachmentCreateFile.optimistic?.(store, {
      id: NEW_ID,
      issue: ISSUE,
      file: FILE,
      upload: { name: 'a.txt', mimeType: 'text/plain', size: 1 },
    });
    expect(writes).toEqual([]);
  });
});

describe('the attachment operations (AC-18)', () => {
  const ops = [
    attachmentCreateFile,
    attachmentCreateLink,
    attachmentUpdate,
    attachmentDelete,
    attachmentSetPreview,
  ];

  it('are registered and pass the registry lint', () => {
    const names = new Set(ALL_OPERATIONS.map((op) => op.name));
    for (const op of ops) {
      expect(names.has(op.name), op.name).toBe(true);
      expect(lintOperations([op])).toEqual([]);
    }
  });

  it('give the public ones a prediction, and delete destructive', () => {
    for (const op of ops.filter((op) => op !== attachmentSetPreview)) {
      expect(typeof op.optimistic, op.name).toBe('function');
      expect(isPublicOperation(op)).toBe(true);
    }
    expect(attachmentDelete.destructive).toBe(true);
  });

  it('hide setPreview from the catalog, OpenAPI, MCP and the command menu', () => {
    expect(attachmentSetPreview.systemOnly).toBe(true);
    expect(isPublicOperation(attachmentSetPreview)).toBe(false);
    expect(attachmentSetPreview.ui).toBeUndefined();
    expect('optimistic' in attachmentSetPreview).toBe(false);
  });

  it('adds the attachment context, and leaves the menu entries to S5', () => {
    expect(UI_CONTEXTS).toContain('attachment');
    // PLAN-014 S5 adds `ui` with the command entries (the web gate checks both together).
    for (const op of ops) expect(op.ui, op.name).toBeUndefined();
  });
});
