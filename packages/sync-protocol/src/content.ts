/**
 * `GET /sync/content` (sync-protocol.md §4.2, SPEC-011 §5.2): the content rows of up to 50
 * parents, read in one snapshot. The body is NDJSON over the bootstrap's line codec: one `meta`,
 * then any number of `row`, then one `end`. `ContentStreamReader` checks the order and the counts,
 * so a cut-off stream is never taken for a whole one.
 */
import { z } from 'zod';
import { decodeWith, ProtocolError } from './errors.js';
import { requireUserId } from './user-id.js';
import {
  modelNameSchema,
  rowSchema,
  schemaHashSchema,
  syncIdSchema,
  userIdSchema,
} from './scalars.js';

export const CONTENT_PATH = '/sync/content';

/** At most this many parents per request (SPEC-011 §5.2). */
export const MAX_CONTENT_PARENTS = 50;

/** The one parent kind in v0.7: an issue (`issue:<uuid>`). */
export const ISSUE_PARENT_PREFIX = 'issue:';

/**
 * A content parent on the wire: `issue:<uuid>`, lower-cased, so the answer's `parents` (ids as
 * Postgres prints them) match what the client asked for.
 */
export type ContentParent = `issue:${string}`;

/** The parent key of an issue: `issue:<id>`, lower-cased. */
export function issueParent(issueId: string): ContentParent {
  return `${ISSUE_PARENT_PREFIX}${issueId.toLowerCase()}`;
}

/** The issue id of a parent key. */
export function parentIssueId(parent: ContentParent): string {
  return parent.slice(ISSUE_PARENT_PREFIX.length);
}

export const contentParentSchema = z
  .templateLiteral([ISSUE_PARENT_PREFIX, z.uuid()])
  .transform((parent) => issueParent(parentIssueId(parent)));

const parentsSchema = z.string().transform((list, ctx) => {
  const parts = list === '' ? [] : list.split(',');
  const fail = (message: string, index?: number) => {
    ctx.addIssue({ code: 'custom', message, ...(index === undefined ? {} : { path: [index] }) });
    return z.NEVER;
  };
  if (parts.length === 0) return fail('Name at least one parent');
  if (parts.length > MAX_CONTENT_PARENTS) {
    return fail(`Name at most ${MAX_CONTENT_PARENTS} parents`);
  }
  const parents: ContentParent[] = [];
  for (const [index, part] of parts.entries()) {
    const parsed = contentParentSchema.safeParse(part);
    if (!parsed.success) return fail('Each parent must be issue:<uuid>', index);
    if (parents.includes(parsed.data)) return fail('A parent is listed twice', index);
    parents.push(parsed.data);
  }
  return parents;
});

/**
 * Query string of `GET /sync/content`: `parents` is a comma-separated list. `userId` is the user
 * the client's replica belongs to (SPEC-002 E14); `schemaHash` lets the server send `426` to an
 * outdated client before any row.
 */
export const contentQuerySchema = z.object({
  parents: parentsSchema,
  userId: userIdSchema,
  schemaHash: schemaHashSchema,
});
export interface ContentQuery {
  readonly parents: readonly ContentParent[];
  readonly userId: string;
  readonly schemaHash: string;
}

/** Build the query string (without `?`) for `GET /sync/content`. */
export function encodeContentQuery(query: ContentQuery): string {
  return new URLSearchParams({
    parents: query.parents.map((parent) => parent.toLowerCase()).join(','),
    userId: query.userId,
    schemaHash: query.schemaHash,
  }).toString();
}

/**
 * Validate the parsed query of `GET /sync/content`. Throws `MissingUserIdError` (answer `426`)
 * when it has no `userId`, else `ProtocolError` (answer `400`) for no parents, more than 50, a
 * malformed or repeated parent, a `userId` that isn't a UUID, or a missing `schemaHash`.
 */
export function decodeContentQuery(query: unknown): ContentQuery {
  requireUserId(query, 'content query');
  return decodeWith(contentQuerySchema, query, 'content query');
}

/** First frame. `parents`: the requested parents found and visible, each hydrated by this answer. */
export const contentMetaSchema = z.object({
  t: z.literal('meta'),
  lastSyncId: syncIdSchema,
  parents: z.array(contentParentSchema),
  /** Exact number of `row` frames that follow (same snapshot). */
  rows: z.int().nonnegative(),
});

/** A content row; the client checks `d` against its model, as for bootstrap. */
export const contentRowSchema = z.object({
  t: z.literal('row'),
  m: modelNameSchema,
  d: rowSchema,
});

/** Last frame: the number of `row` frames sent. */
export const contentEndSchema = z.object({
  t: z.literal('end'),
  rows: z.int().nonnegative(),
});

export const contentFrameSchema = z.discriminatedUnion('t', [
  contentMetaSchema,
  contentRowSchema,
  contentEndSchema,
]);

export type ContentMeta = z.infer<typeof contentMetaSchema>;
export type ContentRow = z.infer<typeof contentRowSchema>;
export type ContentEnd = z.infer<typeof contentEndSchema>;
export type ContentFrame = z.infer<typeof contentFrameSchema>;

/** Validate one decoded NDJSON value as a content frame. Throws `ProtocolError`. */
export function decodeContentFrame(value: unknown): ContentFrame {
  return decodeWith(contentFrameSchema, value, 'content frame');
}

/**
 * Reads one content answer frame by frame: `meta` first and once, rows after it, `end` last with
 * the counts `meta` announced. `finish` throws unless `end` arrived, so a truncated stream is
 * detected (SPEC-011 AC-9). With `requested`, a `meta` naming a parent that wasn't asked for is
 * refused.
 */
export class ContentStreamReader {
  readonly #requested: ReadonlySet<string> | undefined;
  #meta: ContentMeta | undefined;
  #rows = 0;
  #ended = false;

  constructor(requested?: Iterable<ContentParent>) {
    this.#requested =
      requested === undefined ? undefined : new Set([...requested].map((p) => p.toLowerCase()));
  }

  /** Validates the next decoded NDJSON value and returns its frame. Throws `ProtocolError`. */
  read(value: unknown): ContentFrame {
    if (this.#ended) throw new ProtocolError('Invalid content stream: data after end');
    const frame = decodeContentFrame(value);
    switch (frame.t) {
      case 'meta': {
        if (this.#meta !== undefined) {
          throw new ProtocolError('Invalid content stream: second meta frame');
        }
        const extra = frame.parents.find((parent) => !(this.#requested?.has(parent) ?? true));
        if (extra !== undefined) {
          throw new ProtocolError('Invalid content stream: meta names a parent not requested');
        }
        if (new Set(frame.parents).size !== frame.parents.length) {
          throw new ProtocolError('Invalid content stream: meta names a parent twice');
        }
        this.#meta = frame;
        return frame;
      }
      case 'row':
        if (this.#meta === undefined) {
          throw new ProtocolError('Invalid content stream: row before meta');
        }
        this.#rows += 1;
        if (this.#rows > this.#meta.rows) {
          throw new ProtocolError(
            `Invalid content stream: more rows than the ${this.#meta.rows} meta announced`,
          );
        }
        return frame;
      case 'end':
        if (this.#meta === undefined) {
          throw new ProtocolError('Invalid content stream: end before meta');
        }
        if (frame.rows !== this.#rows || this.#meta.rows !== this.#rows) {
          throw new ProtocolError(
            `Invalid content stream: ${this.#rows} rows received, meta announced ${this.#meta.rows}, end announced ${frame.rows}`,
          );
        }
        this.#ended = true;
        return frame;
    }
  }

  /** After the body ends: the answer's `meta` and row count, or `ProtocolError` if it was cut. */
  finish(): { readonly meta: ContentMeta; readonly rows: number } {
    if (!this.#ended || this.#meta === undefined) {
      throw new ProtocolError('Invalid content stream: it ended before the end frame');
    }
    return { meta: this.#meta, rows: this.#rows };
  }
}
