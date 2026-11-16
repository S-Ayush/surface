// What the comment components read of the app: the store's one `CommentActions`, the viewer, the
// names of users and the open issue's identifier and lifecycle.
import { docToMarkdown } from '@surface/editor/schema';
import { User } from '@surface/domain/model';
import type { SyncStore } from '@surface/sync-client';
import { toast } from '@surface/ui';
import { useCallback, useEffect, useState } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { copyText } from '../members/reset-link.js';
import { draftAdapterFor } from '../issues/draft-adapter.js';
import { issueViewFromPool, type IssueLifecycle } from '../issues/issue-view.js';
import { CommentActions } from './actions.js';

const actionsByStore = new WeakMap<SyncStore, CommentActions>();

/** The store's one `CommentActions`, so the pending marker and a late rejection outlive a page. */
export function commentActionsFor(store: SyncStore): CommentActions {
  let actions = actionsByStore.get(store);
  if (actions === undefined) {
    actions = new CommentActions({
      store,
      drafts: draftAdapterFor(store),
      toast: (options) => toast(options),
      markdownOf: docToMarkdown,
      copy: (text) => copyText(text, navigator.clipboard),
    });
    actionsByStore.set(store, actions);
  }
  return actions;
}

export interface CommentWorld {
  readonly store: SyncStore | null;
  readonly me: string | null;
  readonly isAdmin: boolean;
  readonly userName: (id: string) => string;
  /** The open issue as the replica holds it; undefined while it doesn't. */
  readonly issue:
    { readonly identifier: string | null; readonly lifecycle: IssueLifecycle } | undefined;
}

export function useCommentWorld(issueId: string): CommentWorld {
  const app = useApp();
  const store = useObserved(
    useCallback(() => app.readyStore, [app]),
    Object.is,
  );
  const names = useObserved(
    useCallback((): Readonly<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const user of app.readyStore?.pool.all(User) ?? []) out[user.id] = user.displayName;
      return out;
    }, [app]),
  );
  const isAdmin = useObserved(useCallback(() => app.actor()?.role === 'admin', [app]));
  const issue = useObserved(
    useCallback(() => {
      const current = app.readyStore;
      if (current === null) return undefined;
      const view = issueViewFromPool(current.pool, issueId);
      return view === undefined
        ? undefined
        : { identifier: view.identifier, lifecycle: view.lifecycle };
    }, [app, issueId]),
  );
  return {
    store,
    me: app.session?.userId ?? null,
    isAdmin,
    userName: useCallback((id: string) => names[id] ?? 'Someone', [names]),
    issue,
  };
}

/** A clock that moves once a minute, so "3h ago" stays right while the page is open. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}
