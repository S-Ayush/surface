/**
 * Attachment operations (SPEC-014 §6.2; PLAN-014 S4a): attach an uploaded file or a link to an
 * issue, rename an attachment, remove one, and the preview job's system-only `setPreview`.
 *
 * Anyone who can see an issue may attach to it (permissions §3.3); the creator, members of the
 * issue's team and Admins may rename or remove an attachment (§5). Visibility is the executor's
 * check on every reference: an attachment of an issue the caller can't see is `NOT_FOUND`, worded
 * as for an attachment that doesn't exist. Archived and deleted issues are read-only (D11): the
 * handlers lock the issue in `edit` mode and answer `CONFLICT`.
 *
 * The bytes never go through an operation: `POST /files/upload?purpose=attachment` stores them,
 * and `attachment.createFile` attaches the uploaded file. A link is never fetched (D10).
 *
 * Optimistic updates (§6.2 "Optimistic") use the same domain rules as the handlers
 * (`@surface/domain` `attachment.ts`), so the client predicts what the server commits apart from
 * `createdAt`, `updatedAt` and `previewFileId` (AC-17). An issue the store shows archived or
 * deleted is refused at once with the server's message; an issue the store doesn't hold gets no
 * prediction, and the server decides.
 */
import {
  ATTACHMENT_KINDS,
  ATTACHMENT_MESSAGES,
  attachmentTitle,
  attachmentTitleProblem,
  AttachmentRef,
  defaultLinkTitle,
  editRefusal,
  FileRefIncludingDetached,
  issueIdentifier,
  IssueRef,
  lifecycleOf,
  MAX_ATTACHMENTS_PER_ISSUE,
  parseAttachmentUrl,
  teamGroup,
  type PermissionPredicates,
  type ResolvedRefs,
} from '@surface/domain';
import { z } from 'zod';
import { defineOperation } from '../define.js';
import { OptimisticRefusal, type OptimisticStore, type StoreRow } from '../optimistic.js';
import { text } from './content-store.js';
import { Timestamp } from './shared.js';

// ---------------------------------------------------------------------------------------------
// Shapes

const NewId = z
  .uuid({
    version: 'v7',
    error: 'Use a UUIDv7 for id, or leave it out and the server makes one',
  })
  .optional();

/** 1–255 characters after trimming; line breaks become spaces (§4.1). */
const AttachmentTitle = z
  .string()
  .max(10_000, ATTACHMENT_MESSAGES.titleTooLong)
  .superRefine((title, ctx) => {
    const problem = attachmentTitleProblem(title);
    if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
  });

/** An absolute `http(s)` URL without credentials, at most 2,048 characters (§4.1, E11). */
const AttachmentUrl = z
  .string()
  .max(10_000, ATTACHMENT_MESSAGES.urlTooLong)
  .superRefine((url, ctx) => {
    const parsed = parseAttachmentUrl(url);
    if (!parsed.ok) ctx.addIssue({ code: 'custom', message: parsed.problem });
  })
  .meta({ description: 'An http:// or https:// web address. Never fetched.' });

/**
 * What `POST /files/upload` answered (§3.1 step 3), passed back so the client can show the row at
 * once (AC-17). The server ignores it and copies the stored file's own name, type, size and
 * dimensions (SPEC-014 D29).
 */
const UploadAnswer = z
  .object({
    name: z.string().max(1024),
    mimeType: z.string().max(255),
    size: z.int().min(0),
    width: z.int().min(0).optional(),
    height: z.int().min(0).optional(),
  })
  .meta({
    description:
      "The upload's answer (name, mimeType, size, width, height), for the client's own display. Optional; the server reads the file itself.",
  });

const Named = z.object({ id: z.uuid(), name: z.string() });

/**
 * One attachment, as `issue.get` lists it (§6.2). `downloadUrl` is the file's
 * `GET /files/:id` address on your Surface (null for a link); `previewUrl` the preview's, once the
 * preview job made one.
 */
export const AttachmentSummarySchema = z.object({
  id: z.uuid(),
  kind: z.enum(ATTACHMENT_KINDS),
  title: z.string(),
  url: z.string().nullable(),
  fileName: z.string().nullable(),
  mimeType: z.string().nullable(),
  size: z.int().nullable(),
  imageWidth: z.int().nullable(),
  imageHeight: z.int().nullable(),
  downloadUrl: z.string().nullable(),
  previewUrl: z.string().nullable(),
  createdAt: Timestamp,
  creator: Named,
});

/** One attachment with its issue: what the attachment operations return. */
export const AttachmentOutputSchema = AttachmentSummarySchema.extend({
  issue: z.object({ id: z.uuid(), identifier: z.string() }),
  updatedAt: Timestamp,
});

// Fixed ids of the seed fixture's files and attachments (`apps/server/test/seed.ts`), on ENG-1.
const SEED_UPLOAD = '01930000-0000-7000-8000-000000000801';
const SEED_LINK = '01930000-0000-7000-8000-000000000803';
const SEED_FILE_ATTACHMENT = '01930000-0000-7000-8000-000000000804';

// ---------------------------------------------------------------------------------------------
// Permissions

/**
 * The attachment's creator, members of its issue's team, or Admins (§5, permissions §3.3), from the
 * row the executor resolved. `teamName` words the refusal ("members of Engineering").
 */
function mayChange(p: PermissionPredicates, refs: ResolvedRefs): boolean {
  const attachment = refs['attachment'];
  if (attachment === undefined || !('id' in attachment)) return false;
  const teamId = attachment['teamId'];
  const team = {
    id: typeof teamId === 'string' ? teamId : '',
    name: attachment['teamName'],
  };
  return p.owner(attachment) || p.teamMember(team) || p.admin();
}

// ---------------------------------------------------------------------------------------------
// Optimistic helpers

/**
 * The issue a change goes to, as the store shows it. Undefined when the store doesn't hold it (the
 * server decides). Throws `OptimisticRefusal` with the server's message when the store shows it
 * archived or deleted (§3.7: a change still in the overlay, since the store holds neither).
 */
function writableIssue(
  store: OptimisticStore,
  ref: string | undefined,
): { readonly id: string; readonly teamId: string } | undefined {
  if (ref === undefined) return undefined;
  const issue = store.get('Issue', ref);
  const id = text(issue, 'id');
  const teamId = text(issue, 'teamId');
  if (issue === undefined || id === undefined || teamId === undefined) return undefined;
  const state = lifecycleOf({ archivedAt: issue['archivedAt'], deletedAt: issue['deletedAt'] });
  const refusal = editRefusal(identifierOf(store, issue, teamId), state);
  if (refusal !== undefined) throw new OptimisticRefusal(refusal);
  return { id, teamId };
}

/** `ENG-42`, or "This issue" for one without a number yet (as the server words it). */
function identifierOf(store: OptimisticStore, issue: StoreRow, teamId: string): string {
  const key = text(store.get('Team', teamId), 'key');
  const number = issue['number'];
  return key !== undefined && typeof number === 'number'
    ? issueIdentifier(key, number)
    : 'This issue';
}

/** The issue has room for one more attachment, as far as the store shows (D20). */
function hasRoom(store: OptimisticStore, issueId: string): boolean {
  return store.find('Attachment', { issueId }).length < MAX_ATTACHMENTS_PER_ISSUE;
}

/** The attachment and its writable issue, when the store holds both and the actor may change it. */
function changeable(
  store: OptimisticStore,
  ref: string,
): { readonly id: string; readonly row: StoreRow } | undefined {
  const row = store.get('Attachment', ref);
  const id = text(row, 'id');
  if (row === undefined || id === undefined) return undefined;
  const issue = writableIssue(store, text(row, 'issueId'));
  if (issue === undefined) return undefined;
  const me = store.get('User', 'me');
  const userId = text(me, 'id');
  if (userId === undefined) return undefined;
  const member = store.find('TeamMembership', { teamId: issue.teamId, userId }).length > 0;
  // The server refuses anyone else (§5): predicting nothing keeps the overlay equal to it.
  if (text(row, 'creatorId') !== userId && !member && me?.['role'] !== 'admin') return undefined;
  return { id, row };
}

/** A new Attachment row: the fields every kind shares, then the kind's own. */
function newRow(
  store: OptimisticStore,
  issue: { readonly id: string; readonly teamId: string },
  creatorId: string,
  id: string,
  fields: {
    readonly kind: 'file' | 'link';
    readonly title: string;
    readonly url?: string;
    readonly fileId?: string;
    readonly fileName?: string;
    readonly mimeType?: string;
    readonly size?: number;
    readonly imageWidth?: number | null;
    readonly imageHeight?: number | null;
  },
): StoreRow & { readonly id: string } {
  const at = store.now.toISOString();
  return {
    id,
    issueId: issue.id,
    teamId: issue.teamId,
    kind: fields.kind,
    title: fields.title,
    url: fields.url ?? null,
    fileId: fields.fileId ?? null,
    fileName: fields.fileName ?? null,
    mimeType: fields.mimeType ?? null,
    size: fields.size ?? null,
    imageWidth: fields.imageWidth ?? null,
    imageHeight: fields.imageHeight ?? null,
    previewFileId: null,
    creatorId,
    groups: [teamGroup(issue.teamId)],
    createdAt: at,
    updatedAt: at,
  };
}

// ---------------------------------------------------------------------------------------------
// Mutations

export const attachmentCreateFile = defineOperation({
  name: 'attachment.createFile',
  kind: 'mutation',
  domain: 'attachment',
  summary: 'Attach an uploaded file to an issue',
  description:
    'Attaches a file you uploaded with POST /files/upload?purpose=attachment to an issue (ENG-42 or an id). The file must be your own upload not attached yet, or a file just removed from the same issue (to undo the removal). title defaults to the file name. An issue has at most 100 attachments; archived and deleted issues take none.',
  keywords: ['attach file', 'add attachment', 'upload to issue', 'attach screenshot'],
  input: z.object({
    /** Client-generated UUIDv7 (SPEC-003 §8); generated by the server when absent. */
    id: NewId,
    issue: IssueRef,
    // SPEC-014 D28: the only FileRef that resolves a detached file, for the undo of a removal.
    file: FileRefIncludingDetached,
    title: AttachmentTitle.optional(),
    upload: UploadAnswer.optional(),
  }),
  output: AttachmentOutputSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ issue: 'ENG-1', file: SEED_UPLOAD, title: 'Redirect loop screenshot' }],
  // Picking the file opens the browser's picker; the operation runs after the upload (§3.1).
  // `ui` comes with its command entry in PLAN-014 S5 (the web gate needs both together):
  // { title: 'Attach file…', icon: 'paperclip', contexts: ['issue'], shortcut: null }.
  optimistic: (store, input) => {
    if (input.id === undefined) return;
    const issue = writableIssue(store, input.issue);
    const userId = text(store.get('User', 'me'), 'id');
    // Without the upload's answer there is nothing to show yet: the row comes with the server's.
    if (issue === undefined || userId === undefined || input.upload === undefined) return;
    if (!hasRoom(store, issue.id)) return;
    const { name, mimeType, size, width, height } = input.upload;
    store.insert(
      'Attachment',
      newRow(store, issue, userId, input.id, {
        kind: 'file',
        title: attachmentTitle(input.title, name),
        fileId: input.file,
        fileName: name,
        mimeType,
        size,
        imageWidth: width ?? null,
        imageHeight: height ?? null,
      }),
    );
  },
});

export const attachmentCreateLink = defineOperation({
  name: 'attachment.createLink',
  kind: 'mutation',
  domain: 'attachment',
  summary: 'Link a web page to an issue',
  description:
    'Attaches a link to an issue (ENG-42 or an id): an http:// or https:// address without a user name or password, at most 2,048 characters. The page is never fetched: title is what you give, or the address without https://. An issue has at most 100 attachments; archived and deleted issues take none.',
  keywords: ['link url to issue', 'add link', 'attach link', 'link design file'],
  input: z.object({
    id: NewId,
    issue: IssueRef,
    url: AttachmentUrl,
    title: AttachmentTitle.optional(),
  }),
  output: AttachmentOutputSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [
    { issue: 'ENG-1', url: 'https://www.figma.com/file/abc123/Login-flow', title: 'Login flow' },
    { issue: 'ENG-1', url: 'https://status.example.com/incidents/42' },
  ],
  // `ui` comes with its command entry in PLAN-014 S5: { title: 'Link any URL to issue…',
  // icon: 'link', contexts: ['issue'], shortcut: null } (Copy Linear, D9: the literal Control
  // key, on macOS only; the client binds it there).
  optimistic: (store, input) => {
    if (input.id === undefined) return;
    const parsed = parseAttachmentUrl(input.url);
    if (!parsed.ok) return;
    const issue = writableIssue(store, input.issue);
    const userId = text(store.get('User', 'me'), 'id');
    if (issue === undefined || userId === undefined || !hasRoom(store, issue.id)) return;
    store.insert(
      'Attachment',
      newRow(store, issue, userId, input.id, {
        kind: 'link',
        title: attachmentTitle(input.title, defaultLinkTitle(parsed.url)),
        url: parsed.url,
      }),
    );
  },
});

export const attachmentUpdate = defineOperation({
  name: 'attachment.update',
  kind: 'mutation',
  domain: 'attachment',
  summary: 'Rename an attachment',
  description:
    "Changes an attachment's title, 1–255 characters. The attachment's creator, members of its issue's team and Admins can rename it. Archived and deleted issues can't be changed.",
  keywords: ['rename attachment', 'change attachment title', 'edit attachment name'],
  input: z.object({ attachment: AttachmentRef, title: AttachmentTitle }),
  output: AttachmentOutputSchema,
  permission: (p, refs) => mayChange(p, refs),
  destructive: false,
  examples: [{ attachment: SEED_LINK, title: 'Login flow (v2)' }],
  // `ui` comes with its command entry in PLAN-014 S5:
  // { title: 'Rename attachment…', icon: 'pencil', contexts: ['attachment'], shortcut: null }.
  optimistic: (store, input) => {
    const found = changeable(store, input.attachment);
    if (found === undefined) return;
    const current = text(found.row, 'title') ?? '';
    const title = attachmentTitle(input.title, current);
    // The server writes nothing for an unchanged title (§6.2), so `updatedAt` stays too.
    if (title === current) return;
    store.patch('Attachment', found.id, { title, updatedAt: store.now.toISOString() });
  },
});

export const attachmentDelete = defineOperation({
  name: 'attachment.delete',
  kind: 'mutation',
  domain: 'attachment',
  summary: 'Remove an attachment from an issue',
  description:
    "Removes an attachment. A removed file stays for 24 hours, readable by nobody, so attachment.createFile with the same file undoes the removal; after that it is deleted. The attachment's creator, members of its issue's team and Admins can remove it. Archived and deleted issues can't be changed.",
  keywords: ['remove attachment', 'delete attachment', 'detach file', 'unlink url'],
  input: z.object({ attachment: AttachmentRef }),
  output: z.object({ attachment: z.uuid() }),
  permission: (p, refs) => mayChange(p, refs),
  destructive: true,
  examples: [{ attachment: SEED_FILE_ATTACHMENT }],
  // `ui` comes with its command entry in PLAN-014 S5:
  // { title: 'Remove attachment', icon: 'trash', contexts: ['attachment'], shortcut: null }.
  optimistic: (store, input) => {
    const found = changeable(store, input.attachment);
    if (found !== undefined) store.remove('Attachment', found.id);
  },
});

export const attachmentSetPreview = defineOperation({
  name: 'attachment.setPreview',
  kind: 'mutation',
  domain: 'attachment',
  summary: 'Set the preview of an image attachment (the preview job)',
  description:
    'Names the WebP preview the files-preview job made for an image attachment. Only the job calls it, as the system; it is not refused on an archived or deleted issue, and writes no history.',
  keywords: ['set attachment preview', 'image preview job', 'attachment thumbnail'],
  input: z.object({ attachment: AttachmentRef, previewFile: z.uuid() }),
  output: AttachmentOutputSchema,
  systemOnly: true,
  permission: (p) => p.any(),
  destructive: false,
  examples: [
    { attachment: SEED_FILE_ATTACHMENT, previewFile: '01930000-0000-7000-8000-000000000805' },
  ],
});
