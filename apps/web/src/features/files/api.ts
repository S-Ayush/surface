// The account settings' requests outside the store (PLAN-001 S6): uploads, the sessions list and
// its revokes, and the password change. Each is something the user waits for, and a password
// must never sit in the mutation queue (IndexedDB). Tests provide a fake through the context.
import {
  sessionList,
  sessionRevoke,
  sessionRevokeOthers,
  userChangePassword,
  type SessionSchema,
} from '@surface/operations';
import { createContext, useContext } from 'react';
import type { z } from 'zod';
import { csrfFetch, type FetchLike } from '../../app/http.js';
import { postOperation, type OperationAnswer } from './operation.js';
import { uploadImage, type ImagePurpose, type UploadAnswer } from './upload.js';

export type Session = z.output<typeof SessionSchema>;

/** More sessions than anyone has; the list says when there are more. */
export const SESSIONS_PAGE = 100;

export interface SettingsApi {
  upload(file: Blob, purpose: ImagePurpose): Promise<UploadAnswer>;
  sessions(): Promise<OperationAnswer<{ sessions: Session[]; more: boolean }>>;
  revokeSession(sessionId: string): Promise<OperationAnswer<{ revoked: boolean }>>;
  revokeOtherSessions(): Promise<OperationAnswer<{ revoked: number }>>;
  changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<OperationAnswer<{ endedSessions: number }>>;
}

export function httpSettingsApi(fetchFn: FetchLike, cookies: () => string): SettingsApi {
  const send = csrfFetch(fetchFn, cookies);
  return {
    upload: (file, purpose) => uploadImage(send, file, purpose),
    async sessions() {
      const answer = await postOperation(send, sessionList, { limit: SESSIONS_PAGE });
      return answer.ok
        ? {
            ok: true,
            result: { sessions: answer.result.nodes, more: answer.result.pageInfo.hasNextPage },
          }
        : answer;
    },
    revokeSession: (sessionId) => postOperation(send, sessionRevoke, { session: sessionId }),
    revokeOtherSessions: () => postOperation(send, sessionRevokeOthers, {}),
    changePassword: (currentPassword, newPassword) =>
      postOperation(send, userChangePassword, { currentPassword, newPassword }),
  };
}

export const SettingsApiContext = createContext<SettingsApi | null>(null);

// Built on first use, so rendering in tests never touches `window`.
let cached: SettingsApi | undefined;
const browserApi = () =>
  (cached ??= httpSettingsApi(
    (url, init) => window.fetch(url, init),
    () => document.cookie,
  ));
const lazyBrowserApi: SettingsApi = {
  upload: (file, purpose) => browserApi().upload(file, purpose),
  sessions: () => browserApi().sessions(),
  revokeSession: (sessionId) => browserApi().revokeSession(sessionId),
  revokeOtherSessions: () => browserApi().revokeOtherSessions(),
  changePassword: (current, next) => browserApi().changePassword(current, next),
};

export function useSettingsApi(): SettingsApi {
  return useContext(SettingsApiContext) ?? lazyBrowserApi;
}
