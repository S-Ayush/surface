/**
 * `useIssueContent` (SPEC-011 §5.3, §5.4, E11; PLAN-011 S5b), rendered on the server in Node like
 * the other hooks (ADR-0017). The store's content states are tested in sync-client
 * (`content-hydration.test.ts`, `content-dispatch.test.ts`); opening the issue on mount, which
 * needs effects, is left to the web app's views (PLAN-012 S4b, PLAN-013 S5).
 */
import type { ModelRow } from '@surface/domain/model';
import type { ContentLoadState, SyncStore } from '@surface/sync-client';
import { SyncStore as RealStore } from '@surface/sync-client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SyncStoreProvider } from '../src/context.js';
import type { IssueContent } from '../src/hooks.js';
import { useIssueContent, usePrefetchContent, usePrefetchOnHover } from '../src/hooks.js';

function read(store: SyncStore, issueId: string): IssueContent {
  let value: IssueContent | undefined;
  function Probe() {
    value = useIssueContent(issueId);
    return null;
  }
  renderToStaticMarkup(
    <SyncStoreProvider store={store}>
      <Probe />
    </SyncStoreProvider>,
  );
  if (value === undefined) throw new Error('the probe did not render');
  return value;
}

/** A store whose content a test sets, recording the issues opened. */
function fakeStore(
  states: Record<string, ContentLoadState>,
  rows: Record<string, Record<string, ModelRow[]>> = {},
) {
  const opened: string[] = [];
  const content = {
    open: (issueId: string) => {
      opened.push(issueId);
      return { ready: Promise.resolve(states[issueId] ?? 'ready'), release: () => undefined };
    },
    state: (issueId: string) => states[issueId] ?? 'loading',
    rows: (issueId: string) => rows[issueId] ?? {},
  };
  // Only the member the hook uses.
  return { store: { content } as unknown as SyncStore, opened };
}

describe('useIssueContent', () => {
  it('is loading, with no rows, while the store has not started', () => {
    const store = new RealStore({
      models: [],
      workspaceId: 'ws',
      userId: 'user-1',
      clientId: '0190f4c4-0000-7000-8000-00000000c11e',
      fetch: () => Promise.reject(new Error('not used: the store is never started')),
      locks: null,
      connection: { online: { subscribe: () => () => undefined } },
    });
    expect(read(store, 'issue-1')).toEqual({ state: 'loading', rows: {} });
  });

  it("shows the store's rows once the issue is paged in", () => {
    const comment = { id: 'c-1', issueId: 'issue-1', body: 'Hi' };
    const { store } = fakeStore({ 'issue-1': 'ready' }, { 'issue-1': { Comment: [comment] } });
    expect(read(store, 'issue-1')).toEqual({ state: 'ready', rows: { Comment: [comment] } });
  });

  it('is offline for an issue never loaded while the connection is down (E11)', () => {
    const { store } = fakeStore({ 'issue-1': 'offline' });
    expect(read(store, 'issue-1').state).toBe('offline');
  });

  it('opens nothing while rendering: the issue is opened by an effect, after commit', () => {
    const { store, opened } = fakeStore({});
    read(store, 'issue-1');
    expect(opened).toEqual([]);
  });
});

describe('usePrefetchContent and usePrefetchOnHover (PLAN-011 S7)', () => {
  it('ask the store for nothing while rendering: the prefetch is set up by an effect', () => {
    const asked: string[] = [];
    const content = {
      prefetchList: (slot: string) => asked.push(`list ${slot}`),
      prefetchOnHover: (issueId: string) => {
        asked.push(`hover ${issueId}`);
        return () => undefined;
      },
    };
    function Probe() {
      usePrefetchContent(['issue-1', 'issue-2']);
      usePrefetchOnHover();
      return null;
    }
    renderToStaticMarkup(
      <SyncStoreProvider store={{ content } as unknown as SyncStore}>
        <Probe />
      </SyncStoreProvider>,
    );
    expect(asked).toEqual([]);
  });
});
