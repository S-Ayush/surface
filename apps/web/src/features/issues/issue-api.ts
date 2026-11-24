// Issue reads over `POST /api/ops/:name` (SPEC-003 §9) for what the replica doesn't hold:
// `issue.get` for one issue (SPEC-012 §3.4 item 11), and the archive page's `issue.list`,
// `issue.listDeleted` and `issue.count` (SPEC-015 §3.3, SPEC-012 §3.3 item 6; PLAN-015 S4).
// Reading, not a state change, so they don't go through the mutation queue. Tests provide a fake
// through the context.
import {
  issueCount,
  issueGet,
  issueList,
  issueListDeleted,
  type InputOf,
} from '@surface/operations';
import { createContext, useContext } from 'react';
import type { z } from 'zod';
import { csrfFetch, type FetchLike } from '../../app/http.js';
import { postOperation, type OperationAnswer } from '../files/operation.js';
import type { IssueOutput } from './issue-view.js';

export type IssuePage = z.output<(typeof issueList)['output']>;
export type DeletedIssuePage = z.output<(typeof issueListDeleted)['output']>;

export interface IssueApi {
  get(ref: string): Promise<OperationAnswer<IssueOutput>>;
  /** The archive page's queries; optional so a test of the issue page needs only `get`. */
  list?(input: InputOf<typeof issueList>): Promise<OperationAnswer<IssuePage>>;
  listDeleted?(input: InputOf<typeof issueListDeleted>): Promise<OperationAnswer<DeletedIssuePage>>;
  count?(input: InputOf<typeof issueCount>): Promise<OperationAnswer<{ count: number }>>;
}

export function httpIssueApi(fetchFn: FetchLike, cookies: () => string): IssueApi {
  const send = csrfFetch(fetchFn, cookies);
  return {
    get: (ref) => postOperation(send, issueGet, { issue: ref }),
    list: (input) => postOperation(send, issueList, input),
    listDeleted: (input) => postOperation(send, issueListDeleted, input),
    count: (input) => postOperation(send, issueCount, input),
  };
}

export const IssueApiContext = createContext<IssueApi | null>(null);

// Built on first use, so rendering in tests never touches `window`.
let cached: IssueApi | undefined;
const browserApi = (): IssueApi =>
  (cached ??= httpIssueApi(
    (url, init) => window.fetch(url, init),
    () => document.cookie,
  ));
const lazyBrowserApi: IssueApi = {
  get: (ref) => browserApi().get(ref),
  list: (input) => browserApi().list?.(input) ?? Promise.reject(new Error('no list')),
  listDeleted: (input) =>
    browserApi().listDeleted?.(input) ?? Promise.reject(new Error('no listDeleted')),
  count: (input) => browserApi().count?.(input) ?? Promise.reject(new Error('no count')),
};

export function useIssueApi(): IssueApi {
  return useContext(IssueApiContext) ?? lazyBrowserApi;
}
