/**
 * Attachments (SPEC-014 §4.1, §5; PLAN-014 S4a): an eager model that belongs to an issue. Its
 * groups are `team:<teamId>` only, never the issue's `user:` groups (SPEC-011 §5.7), with `teamId`
 * taken from the issue row by the server. The client holds an issue's attachments only while it
 * holds the issue: they leave with it (`EAGER_ISSUE_CHILDREN`) and come back with a restore's `U`s.
 *
 * File rows are server-only (D15): a file attachment carries the file's name, type, size and
 * dimensions, so the client needs nothing else, and loads the bytes from `GET /files/:id`.
 */
import { ATTACHMENT_KINDS } from '../attachment.js';
import { defineModel, ref } from './define-model.js';
import { array, enumOf, int, str, timestamp, uuid } from './fields.js';

export const Attachment = defineModel('Attachment', {
  load: 'eager',
  fields: {
    /** Set at creation; never changes. */
    issueId: uuid(),
    /** The issue's team, set by the server from the issue row (SPEC-011 §5.1). */
    teamId: uuid(),
    kind: enumOf(ATTACHMENT_KINDS),
    /** 1–255 characters, trimmed. */
    title: str(),
    /** `link` only: an absolute `http(s)` URL, never fetched. */
    url: str().nullable(),
    /** `file` only: the server-only `files` row. */
    fileId: uuid().nullable(),
    fileName: str().nullable(),
    mimeType: str().nullable(),
    /** Bytes (`bigint` in Postgres; exact below 2⁵³). */
    size: int().nullable(),
    imageWidth: int().nullable(),
    imageHeight: int().nullable(),
    /** Set by `attachment.setPreview` once the preview job made one (§4.4). */
    previewFileId: uuid().nullable(),
    creatorId: uuid(),
    groups: array(str()),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  },
  refs: {
    issue: ref('Issue', 'issueId'),
    team: ref('Team', 'teamId'),
    creator: ref('User', 'creatorId'),
  },
  indexes: ['issueId'],
});
