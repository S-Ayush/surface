// The invite requests (PLAN-001 S5, SPEC-001 §3.4). They go straight to the server, not through
// the store: invites never reach the replica, and `invite.create`'s answer is the link, shown once
// (the mutation queue keeps no results). The invite page uses the two routes outside the executor
// (§6.1, D8): the invitee has no account yet. Writes go through `csrfFetch`, like the other forms.
import { LIST_LIMIT_MAX, inviteCreate, inviteList, inviteRevoke } from '@surface/operations';
import type { UserRole } from '@surface/domain';
import { createContext, useContext } from 'react';
import { z } from 'zod';
import { csrfFetch, errorOf, type FetchLike } from '../../app/http.js';

export const UNREACHABLE = "Couldn't reach Surface. Check your connection, then try again.";

export type Invite = z.infer<typeof inviteCreate.output>['invite'];

export type Failure = { readonly ok: false; readonly message: string };

export type CreateInviteInput = {
  readonly email?: string;
  readonly role: UserRole;
  readonly teams: readonly string[];
};

export type CreateInviteResult =
  | { readonly ok: true; readonly invite: Invite; readonly url: string; readonly emailed: boolean }
  /** `field: 'email'` for a refusal about the email (E3), shown under it. */
  | (Failure & { readonly field?: 'email' });

export type PendingInvitesResult =
  { readonly ok: true; readonly invites: readonly Invite[]; readonly more: boolean } | Failure;

export type RevokeResult = { readonly ok: true } | Failure;

/** What the invite page shows: the workspace, who invited, and the email if the invite has one. */
export const InviteDetailsSchema = z.object({
  workspaceName: z.string(),
  inviterName: z.string(),
  email: z.string().nullable(),
  role: z.enum(['admin', 'member']),
});
export type InviteDetails = z.infer<typeof InviteDetailsSchema>;

export type InviteDetailsResult =
  | { readonly ok: true; readonly invite: InviteDetails }
  /** Used, revoked, expired or never existed (E4): the page says so, without telling which. */
  | { readonly ok: false; readonly invalid: true; readonly message: string }
  | (Failure & { readonly invalid: false });

export type AcceptField = 'name' | 'displayName' | 'password' | 'email';

export type AcceptBody = {
  readonly name: string;
  readonly displayName: string;
  readonly password: string;
  readonly email?: string;
  readonly timezone?: string;
};

export type AcceptResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly message: string;
      /** The field the refusal is about (E3, E5, a field check), shown under it. */
      readonly field?: AcceptField;
      /** The invite stopped being valid (E4). */
      readonly invalid?: boolean;
    };

export interface InvitesApi {
  create(input: CreateInviteInput): Promise<CreateInviteResult>;
  /** Pending invites, newest first. */
  pending(): Promise<PendingInvitesResult>;
  revoke(inviteId: string): Promise<RevokeResult>;
  details(token: string): Promise<InviteDetailsResult>;
  accept(token: string, body: AcceptBody): Promise<AcceptResult>;
}

const ACCEPT_FIELDS: readonly AcceptField[] = ['name', 'displayName', 'password', 'email'];

/** The field a SPEC-003 error's first issue names, if it is one of `fields`. */
const IssueField = z.object({
  error: z.object({ issues: z.array(z.object({ path: z.array(z.unknown()) })).min(1) }),
});
function fieldOf<F extends string>(body: unknown, fields: readonly F[]): F | undefined {
  const parsed = IssueField.safeParse(body);
  const first = parsed.success ? parsed.data.error.issues[0]?.path[0] : undefined;
  return fields.find((field) => field === first);
}

/** The body of a refused answer, or undefined; it is read from a clone, as `errorOf` does. */
async function bodyOf(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.clone().json();
    return body;
  } catch {
    return undefined;
  }
}

const ResultBody = z.object({ result: z.unknown() });

export function httpInvitesApi(fetchFn: FetchLike, cookies: () => string): InvitesApi {
  const send = csrfFetch(fetchFn, cookies);
  const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' };

  /** Runs an operation; its parsed result, or what to show. */
  async function run<T>(
    name: string,
    input: object,
    parse: (result: unknown) => T,
  ): Promise<{ ok: true; result: T } | (Failure & { readonly body?: unknown })> {
    let response: Response;
    try {
      response = await send(`/api/ops/${name}`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ input }),
      });
    } catch {
      return { ok: false, message: UNREACHABLE };
    }
    if (!response.ok) {
      // A refusal says what to do; a server failure's message is never shown (SPEC-003).
      if (response.status >= 500) return { ok: false, message: UNREACHABLE };
      const error = await errorOf(response);
      return { ok: false, message: error?.message ?? UNREACHABLE, body: await bodyOf(response) };
    }
    try {
      return { ok: true, result: parse(ResultBody.parse(await response.json()).result) };
    } catch {
      return { ok: false, message: UNREACHABLE };
    }
  }

  return {
    async create(input) {
      const answer = await run(
        inviteCreate.name,
        {
          ...(input.email === undefined ? {} : { email: input.email }),
          role: input.role,
          teams: input.teams,
        },
        (result) => inviteCreate.output.parse(result),
      );
      if (answer.ok) return { ok: true, ...answer.result };
      const field = fieldOf(answer.body, ['email'] as const);
      return { ok: false, message: answer.message, ...(field === undefined ? {} : { field }) };
    },

    async pending() {
      const answer = await run(
        inviteList.name,
        { filter: { field: 'status', op: 'eq', value: 'pending' }, limit: LIST_LIMIT_MAX },
        (result) => inviteList.output.parse(result),
      );
      return answer.ok
        ? { ok: true, invites: answer.result.nodes, more: answer.result.pageInfo.hasNextPage }
        : { ok: false, message: answer.message };
    },

    async revoke(inviteId) {
      const answer = await run(inviteRevoke.name, { invite: inviteId }, (result) =>
        inviteRevoke.output.parse(result),
      );
      return answer.ok ? { ok: true } : { ok: false, message: answer.message };
    },

    async details(token) {
      let response: Response;
      try {
        response = await fetchFn(`/api/invite/${encodeURIComponent(token)}`, {
          headers: { accept: 'application/json' },
        });
      } catch {
        return { ok: false, invalid: false, message: UNREACHABLE };
      }
      if (response.status === 404) {
        const error = await errorOf(response);
        return { ok: false, invalid: true, message: error?.message ?? UNREACHABLE };
      }
      if (!response.ok) {
        const error = response.status < 500 ? await errorOf(response) : undefined;
        return { ok: false, invalid: false, message: error?.message ?? UNREACHABLE };
      }
      try {
        const invite = InviteDetailsSchema.parse(ResultBody.parse(await response.json()).result);
        return { ok: true, invite };
      } catch {
        return { ok: false, invalid: false, message: UNREACHABLE };
      }
    },

    async accept(token, body) {
      let response: Response;
      try {
        response = await send(`/api/invite/${encodeURIComponent(token)}/accept`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
        });
      } catch {
        return { ok: false, message: UNREACHABLE };
      }
      if (response.ok) return { ok: true };
      if (response.status >= 500) return { ok: false, message: UNREACHABLE };
      // `errorOf` reads a clone, so the body is still there for the field.
      const error = await errorOf(response);
      const field = fieldOf(await bodyOf(response), ACCEPT_FIELDS);
      return {
        ok: false,
        message: error?.message ?? UNREACHABLE,
        ...(field === undefined ? {} : { field }),
        ...(response.status === 404 ? { invalid: true } : {}),
      };
    },
  };
}

/** The API the invite screens use; tests provide a fake. */
export const InvitesApiContext = createContext<InvitesApi | null>(null);

// Built on first use, so rendering in tests never touches `window`.
let cached: InvitesApi | undefined;
const browserApi = (): InvitesApi =>
  (cached ??= httpInvitesApi(
    (url, init) => window.fetch(url, init),
    () => document.cookie,
  ));
const lazyBrowserApi: InvitesApi = {
  create: (input) => browserApi().create(input),
  pending: () => browserApi().pending(),
  revoke: (id) => browserApi().revoke(id),
  details: (token) => browserApi().details(token),
  accept: (token, body) => browserApi().accept(token, body),
};

export function useInvitesApi(): InvitesApi {
  return useContext(InvitesApiContext) ?? lazyBrowserApi;
}
