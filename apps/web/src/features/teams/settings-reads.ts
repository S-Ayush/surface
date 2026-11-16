// Counts the settings pages read from the server (SPEC-010 §5, D15): the replica holds only the
// issues of subscribed teams (SPEC-011 §5.7), so it can't count them. `label.usage` fills the
// labels page's Used in, Issues and Last applied columns; `issue.groupBy` by status the workflow
// page's issue counts. Reads, not state changes, so they go over `POST /api/ops/:name` and never
// through the mutation queue. Asked when the page opens and again when the window regains focus;
// offline, and until the answer arrives, the page shows "—". Tests provide a fake through the
// context.
import { issueGroupBy, labelUsage, type InputOf, type OutputOf } from '@surface/operations';
import { createContext, useContext, useEffect, useEffectEvent, useState } from 'react';
import { csrfFetch, type FetchLike } from '../../app/http.js';
import { postOperation, type OperationAnswer } from '../files/operation.js';

export type LabelUsageInput = InputOf<typeof labelUsage>;
export type LabelUsageOutput = OutputOf<typeof labelUsage>;
export type IssueGroupByInput = InputOf<typeof issueGroupBy>;
export type IssueGroupByOutput = OutputOf<typeof issueGroupBy>;

export interface SettingsReads {
  labelUsage(input: LabelUsageInput): Promise<OperationAnswer<LabelUsageOutput>>;
  issueGroupBy(input: IssueGroupByInput): Promise<OperationAnswer<IssueGroupByOutput>>;
}

export function httpSettingsReads(fetchFn: FetchLike, cookies: () => string): SettingsReads {
  const send = csrfFetch(fetchFn, cookies);
  return {
    labelUsage: (input) => postOperation(send, labelUsage, input),
    issueGroupBy: (input) => postOperation(send, issueGroupBy, input),
  };
}

export const SettingsReadsContext = createContext<SettingsReads | null>(null);

// Built on first use, so rendering in tests never touches `window`.
let cached: SettingsReads | undefined;
const browser = (): SettingsReads =>
  (cached ??= httpSettingsReads(
    (url, init) => window.fetch(url, init),
    () => document.cookie,
  ));
const lazyBrowserReads: SettingsReads = {
  labelUsage: (input) => browser().labelUsage(input),
  issueGroupBy: (input) => browser().issueGroupBy(input),
};

export function useSettingsReads(): SettingsReads {
  return useContext(SettingsReadsContext) ?? lazyBrowserReads;
}

/**
 * The latest answer of `read` while `online`, asked again whenever `key` changes and when the
 * window regains focus. `undefined` until an answer arrives, offline (the counts may be stale and
 * nothing can refresh them), and after a refusal or a failed request.
 */
export function useServerRead<T>(
  read: () => Promise<OperationAnswer<T>>,
  key: string,
  online: boolean,
): T | undefined {
  const [answer, setAnswer] = useState<{ readonly key: string; readonly value: T }>();
  const [round, setRound] = useState(0);

  useEffect(() => {
    const again = () => {
      if (document.visibilityState !== 'hidden') setRound((n) => n + 1);
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, []);

  // `read` is rebuilt each render; `key` names what it asks, so only a new key asks again.
  const ask = useEffectEvent(() => read());
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    void ask().then((result) => {
      if (cancelled) return;
      if (result.ok) setAnswer({ key, value: result.result });
      else setAnswer(undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [key, online, round]);

  return online && answer?.key === key ? answer.value : undefined;
}
