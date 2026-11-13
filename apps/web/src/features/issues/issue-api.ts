// `issue.get` over `POST /api/ops/issue.get` (SPEC-003 §9), for an issue the replica doesn't hold
// (SPEC-012 §3.4 item 11). Reading, not a state change, so it doesn't go through the mutation
// queue. Tests provide a fake through the context.
import { issueGet } from '@surface/operations';
import { createContext, useContext } from 'react';
import { csrfFetch, type FetchLike } from '../../app/http.js';
import { postOperation, type OperationAnswer } from '../files/operation.js';
import type { IssueOutput } from './issue-view.js';

export interface IssueApi {
  get(ref: string): Promise<OperationAnswer<IssueOutput>>;
}

export function httpIssueApi(fetchFn: FetchLike, cookies: () => string): IssueApi {
  const send = csrfFetch(fetchFn, cookies);
  return { get: (ref) => postOperation(send, issueGet, { issue: ref }) };
}

export const IssueApiContext = createContext<IssueApi | null>(null);

// Built on first use, so rendering in tests never touches `window`.
let cached: IssueApi | undefined;
const lazyBrowserApi: IssueApi = {
  get: (ref) =>
    (cached ??= httpIssueApi(
      (url, init) => window.fetch(url, init),
      () => document.cookie,
    )).get(ref),
};

export function useIssueApi(): IssueApi {
  return useContext(IssueApiContext) ?? lazyBrowserApi;
}
