// The server-backed read-only view (SPEC-012 §3.4 item 8, SPEC-015 §3.4, AC-26; PLAN-012 S4b): an
// archived or deleted issue, or one that left the replica while open (E3), isn't in the replica,
// so its activity, comments and reactions come from one `content.peek` answer, held here in
// memory and never stored. The row and description come from `issue.get` (`issue-loader.ts`).
// The page asks again when the window regains focus.
import { isDocJson, type DocNodeJSON } from '@surface/domain';
import { IssueContent, type ModelRow } from '@surface/domain/model';
import type { ContentPeek } from '@surface/sync-client';
import { useIssueContent } from '@surface/sync-react';
import { createContext, use, useEffect, useState } from 'react';

/** An issue's content as the page's activity, comments and reactions read it. */
export interface ContentView {
  /** `failed`: the server-backed read failed while online (the page offers no retry but focus). */
  readonly state: 'loading' | 'ready' | 'offline' | 'failed';
  readonly rows: Readonly<Record<string, readonly ModelRow[]>>;
}

/** The server-backed content of one issue, for the slots under it. */
export interface ServerContent extends ContentView {
  readonly issueId: string;
}

const NO_ROWS: ContentView['rows'] = {};

/** What `content.peek` answered, as the view shows it. */
export function serverContentOf(issueId: string, peek: ContentPeek): ServerContent {
  if (peek.state !== 'ready') return { issueId, state: peek.state, rows: NO_ROWS };
  return { issueId, state: 'ready', rows: peek.rows };
}

/**
 * Peeks `issueId`'s content while `enabled`, again whenever `refresh` changes. A refresh keeps the
 * rows shown until its answer; a failed refresh keeps them too.
 */
export function useServerContent(
  issueId: string,
  enabled: boolean,
  peek: ((issueId: string) => Promise<ContentPeek>) | undefined,
  refresh: number,
): ServerContent | undefined {
  const [held, setHeld] = useState<ServerContent | undefined>(undefined);
  useEffect(() => {
    if (!enabled || peek === undefined) return;
    let current = true;
    void peek(issueId).then(
      (answer) => {
        if (!current) return;
        const next = serverContentOf(issueId, answer);
        setHeld((before) =>
          next.state !== 'ready' && before?.issueId === issueId && before.state === 'ready'
            ? before
            : next,
        );
      },
      () => {
        if (current) setHeld({ issueId, state: 'failed', rows: NO_ROWS });
      },
    );
    return () => {
      current = false;
    };
  }, [issueId, enabled, peek, refresh]);
  if (!enabled) return undefined;
  return held?.issueId === issueId ? held : { issueId, state: 'loading', rows: NO_ROWS };
}

/** The issue page provides it in the read-only view; the comment and reaction slots read it. */
export const ServerContentContext = createContext<ServerContent | null>(null);

/**
 * An issue's content for the page's slots: the server-backed answer in the read-only view (the
 * replica doesn't hold the issue, so nothing is opened or hydrated), else the replica's, opened
 * while mounted (`useIssueContent`, which also hydrates on open, SPEC-012 §3.4 item 10).
 */
export function useIssueContentView(issueId: string): ContentView & { readonly server: boolean } {
  const server = use(ServerContentContext);
  const fromServer = server !== null && server.issueId === issueId;
  const live = useIssueContent(fromServer ? '' : issueId);
  return fromServer
    ? { state: server.state, rows: server.rows, server: true }
    : { state: live.state, rows: live.rows, server: false };
}

/** The issue's description and version, from its `IssueContent` row (undefined without one). */
export function descriptionOf(
  rows: readonly ModelRow[] | undefined,
): { readonly doc: DocNodeJSON; readonly version: number } | undefined {
  const parsed = IssueContent.rowSchema.safeParse(rows?.[0]);
  if (!parsed.success) return undefined;
  const doc: unknown = parsed.data.description;
  return isDocJson(doc) ? { doc, version: parsed.data.version } : undefined;
}
