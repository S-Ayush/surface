/**
 * Draft operations (SPEC-012 §3.2, §4.3; PLAN-012 S5): `draft.save` and `draft.discard`, on the
 * actor's own `Draft` rows (synced only in `user:<id>`). A draft is keyed by kind and its team
 * (composer) or issue (comment). Neither operation resolves the team or the issue, or checks a
 * team permission: a draft is its owner's data, the owner may hold or delete one for a team they
 * can no longer see, and resolving would answer differently for a team that exists. So the ids
 * are opaque (`opaqueIds`, SPEC-012 D23), not reference types.
 *
 * Both are optimistic, so drafts save offline and queue like any change (E19). The optimistic
 * updates make the same choices as the handlers: the same key, the same cap of 50 drafts of each
 * kind.
 */
import {
  DRAFT_LIMITS,
  CommentDraftData,
  ComposerDraftData,
  DRAFT_KINDS,
  type DraftKind,
} from '@surface/domain/model';
import { z } from 'zod';
import { defineOperation } from '../define.js';
import type { OptimisticStore, StoreRow } from '../optimistic.js';
import { Timestamp } from './shared.js';

const NewId = z
  .uuid({
    version: 'v7',
    error: 'Use a UUIDv7 for id, or leave it out and the server makes one',
  })
  .optional();

/** The fields that name a draft: its kind, and its team (composer) or issue (comment). */
const keyFields = {
  kind: z.enum(DRAFT_KINDS),
  teamId: z.uuid().optional(),
  issueId: z.uuid().optional(),
};

type KeyInput = {
  readonly kind: DraftKind;
  readonly teamId?: string | undefined;
  readonly issueId?: string | undefined;
};

/** The key's problem, with its path: a composer draft names a team only, a comment an issue only. */
export function draftKeyProblem(input: KeyInput): { path: string; message: string } | undefined {
  if (input.kind === 'composer') {
    if (input.teamId === undefined)
      return { path: 'teamId', message: 'A composer draft needs teamId.' };
    if (input.issueId !== undefined)
      return { path: 'issueId', message: 'A composer draft has no issueId. Remove it.' };
    return undefined;
  }
  if (input.issueId === undefined)
    return { path: 'issueId', message: 'A comment draft needs issueId.' };
  if (input.teamId !== undefined)
    return { path: 'teamId', message: 'A comment draft has no teamId. Remove it.' };
  return undefined;
}

/** The store fields a draft's key matches on. */
export type DraftKey =
  | { readonly kind: 'composer'; readonly teamId: string }
  | { readonly kind: 'comment'; readonly issueId: string };

/** The key of a valid input (`draftKeyProblem` passed). */
export function draftKeyOf(input: KeyInput): DraftKey | undefined {
  if (input.kind === 'composer') {
    return input.teamId === undefined ? undefined : { kind: 'composer', teamId: input.teamId };
  }
  return input.issueId === undefined ? undefined : { kind: 'comment', issueId: input.issueId };
}

export const DraftSchema = z.object({
  id: z.uuid(),
  kind: z.enum(DRAFT_KINDS),
  teamId: z.uuid().nullable(),
  issueId: z.uuid().nullable(),
  data: z.json(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

const text = (row: StoreRow | undefined, field: string): string | undefined => {
  const value = row?.[field];
  return typeof value === 'string' ? value : undefined;
};

/** The drafts beyond `limit`, oldest first: by `updatedAt`, then id (the handler's order). */
export function draftsOverLimit<R extends { readonly id: string; readonly updatedAt: string }>(
  drafts: readonly R[],
  limit: number,
): R[] {
  // Instants compare as times (a wire row may write the offset as `Z` or `+00:00`); ids as the
  // server's `uuid` order, which is the lowercase text order.
  const newestFirst = [...drafts].sort(
    (a, b) =>
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
      (a.id.toLowerCase() < b.id.toLowerCase() ? 1 : a.id === b.id ? 0 : -1),
  );
  return newestFirst.slice(limit);
}

function findDraft(store: OptimisticStore, me: string, key: DraftKey): StoreRow | undefined {
  return store.find('Draft', { userId: me, ...key })[0];
}

export const draftSave = defineOperation({
  name: 'draft.save',
  kind: 'mutation',
  domain: 'draft',
  summary: 'Save a composer or comment draft',
  description:
    'Saves your draft of a new issue in a team (kind composer, teamId) or of a comment on an issue (kind comment, issueId), replacing the one you had there. Drafts are yours only and sync to your devices. You keep at most 50 of each kind: saving one more deletes your oldest of that kind.',
  keywords: ['save draft', 'keep draft', 'save issue for later', 'unsent comment'],
  input: z
    .object({
      /** Client-generated UUIDv7 for a new draft; ignored when one with this key exists. */
      id: NewId,
      ...keyFields,
      data: z.union([ComposerDraftData, CommentDraftData]),
    })
    .superRefine((input, ctx) => {
      const problem = draftKeyProblem(input);
      if (problem !== undefined) {
        ctx.addIssue({ code: 'custom', path: [problem.path], message: problem.message });
      }
      const composerData = 'title' in input.data;
      if (composerData !== (input.kind === 'composer')) {
        ctx.addIssue({
          code: 'custom',
          path: ['data'],
          message:
            input.kind === 'composer'
              ? 'A composer draft keeps title, description and the properties.'
              : 'A comment draft keeps text only.',
        });
      }
    }),
  output: DraftSchema,
  opaqueIds: ['id', 'teamId', 'issueId', 'data.statusId', 'data.assigneeId', 'data.labelIds[]'],
  // Anyone signed in, for their own drafts only: the handler writes the actor's rows.
  permission: (p) => p.any(),
  destructive: false,
  examples: [
    {
      kind: 'composer',
      teamId: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e',
      data: {
        title: 'Fix the login redirect loop',
        description: null,
        statusId: null,
        priority: 2,
        assigneeId: null,
        labelIds: [],
        estimate: null,
        dueDate: null,
      },
    },
    {
      kind: 'comment',
      issueId: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6f',
      data: {
        text: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks good' }] }],
        },
      },
    },
  ],
  optimistic: (store, input) => {
    const me = text(store.get('User', 'me'), 'id');
    const key = draftKeyOf(input);
    if (me === undefined || key === undefined) return;
    const at = store.now.toISOString();
    const existing = findDraft(store, me, key);
    const existingId = text(existing, 'id');
    if (existingId !== undefined) {
      store.patch('Draft', existingId, { data: input.data, updatedAt: at });
    } else if (input.id !== undefined) {
      store.insert('Draft', {
        id: input.id,
        userId: me,
        kind: key.kind,
        teamId: key.kind === 'composer' ? key.teamId : null,
        issueId: key.kind === 'comment' ? key.issueId : null,
        data: input.data,
        createdAt: at,
        updatedAt: at,
      });
    } else {
      return;
    }
    // 50 of each kind, like the handler (SPEC-012 §3.2, §4.3).
    const sameKind = store.find('Draft', { userId: me, kind: key.kind }).flatMap((row) => {
      const id = text(row, 'id');
      const updatedAt = text(row, 'updatedAt');
      return id === undefined || updatedAt === undefined ? [] : [{ id, updatedAt }];
    });
    for (const old of draftsOverLimit(sameKind, DRAFT_LIMITS[key.kind])) {
      store.remove('Draft', old.id);
    }
  },
});

export const draftDiscard = defineOperation({
  name: 'draft.discard',
  kind: 'mutation',
  domain: 'draft',
  summary: 'Discard a composer or comment draft',
  description:
    'Deletes your draft of a new issue in a team (kind composer, teamId) or of a comment on an issue (kind comment, issueId). Discarding a draft you no longer have succeeds and changes nothing.',
  keywords: ['discard draft', 'delete draft', 'throw away draft', 'clear draft'],
  input: z.object(keyFields).superRefine((input, ctx) => {
    const problem = draftKeyProblem(input);
    if (problem !== undefined) {
      ctx.addIssue({ code: 'custom', path: [problem.path], message: problem.message });
    }
  }),
  output: z.object({ discarded: z.boolean() }),
  opaqueIds: ['teamId', 'issueId'],
  permission: (p) => p.any(),
  // Not destructive in the registry's sense (SPEC-003 §11 rule 5 names delete, remove, purge and
  // deactivate): it drops the actor's own unsent text, which the actor chose to discard.
  destructive: false,
  examples: [
    { kind: 'composer', teamId: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e' },
    { kind: 'comment', issueId: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6f' },
  ],
  optimistic: (store, input) => {
    const me = text(store.get('User', 'me'), 'id');
    const key = draftKeyOf(input);
    if (me === undefined || key === undefined) return;
    const id = text(findDraft(store, me, key), 'id');
    if (id !== undefined) store.remove('Draft', id);
  },
});
