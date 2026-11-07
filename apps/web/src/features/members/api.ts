// Settings → Members' one request outside the store (PLAN-001 S7): an Admin's reset link
// (`user.createResetLink`, SPEC-001 §3.3). It goes straight to `POST /api/ops/…` because its
// answer is the link, shown once: the store's mutation queue keeps no results, and a link
// generated later, while nobody watches, would only turn off the person's earlier one.
import { userCreateResetLink } from '@surface/operations';
import { createContext, useContext } from 'react';
import { csrfFetch, errorOf, type FetchLike } from '../../app/http.js';

export type ResetLinkResult =
  | { readonly ok: true; readonly url: string; readonly expiresAt: Date }
  | { readonly ok: false; readonly message: string };

export interface MembersApi {
  createResetLink(userId: string): Promise<ResetLinkResult>;
}

export const UNREACHABLE = "Couldn't reach Surface. Check your connection, then try again.";

export function httpMembersApi(fetchFn: FetchLike, cookies: () => string): MembersApi {
  const send = csrfFetch(fetchFn, cookies);
  return {
    async createResetLink(userId) {
      let response: Response;
      try {
        response = await send(`/api/ops/${userCreateResetLink.name}`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ input: { user: userId } }),
        });
      } catch {
        return { ok: false, message: UNREACHABLE };
      }
      if (!response.ok) {
        // A refusal says what to do; a server failure's message is never shown (SPEC-003).
        const error = response.status < 500 ? await errorOf(response) : undefined;
        return { ok: false, message: error?.message ?? UNREACHABLE };
      }
      try {
        const body: unknown = await response.json();
        const result = userCreateResetLink.output.parse(
          typeof body === 'object' && body !== null ? Reflect.get(body, 'result') : undefined,
        );
        return { ok: true, url: result.url, expiresAt: new Date(result.expiresAt) };
      } catch {
        return { ok: false, message: UNREACHABLE };
      }
    },
  };
}

/** The API Settings → Members uses; tests provide a fake. */
export const MembersApiContext = createContext<MembersApi | null>(null);

// Built on first use, so rendering in tests never touches `window`.
let cached: MembersApi | undefined;
const lazyBrowserApi: MembersApi = {
  createResetLink: (userId) =>
    (cached ??= httpMembersApi(
      (url, init) => window.fetch(url, init),
      () => document.cookie,
    )).createResetLink(userId),
};

export function useMembersApi(): MembersApi {
  return useContext(MembersApiContext) ?? lazyBrowserApi;
}
