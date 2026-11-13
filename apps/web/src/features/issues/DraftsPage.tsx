// The Drafts page (`/drafts`, `G` `D`; SPEC-012 §3.2): every composer draft (title, team, saved
// time) and every unsent comment (issue identifier and title, first line, saved time), newest
// first. A comment draft whose issue the replica doesn't hold is looked up with `issue.get` while
// online: a live issue shows, an archived, deleted or unknown one is hidden; offline it shows as
// "Issue not loaded" (E18). Each row's menu has **Delete draft**.
import { issueIdentifier, issuePath } from '@surface/domain';
import { docFirstLine, Issue, readComposerDraft, Team } from '@surface/domain/model';
import { EmptyState, IconButton, Menu } from '@surface/ui';
import { useNavigate } from '@tanstack/react-router';
import { FilePen, MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { PageHeader } from '../../shell/PageHeader.js';
import { useCommandRegistry } from '../../shortcuts/ShortcutProvider.js';
import styles from './composer.module.css';
import { openComposerWith } from './composer-request.js';
import { draftAdapterFor, type DraftEntry } from './draft-adapter.js';
import { useIssueApi } from './issue-api.js';
import { canonicalIssuePath } from './issue-url.js';
import { agoText } from './issue-view.js';

/** What `issue.get` said about an issue the replica doesn't hold. */
type Remote =
  | { readonly kind: 'live'; readonly identifier: string; readonly title: string }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'offline' };

/** One row, as the page shows it; null when it is hidden (E18). */
export interface DraftLine {
  readonly key: string;
  readonly entry: DraftEntry;
  readonly title: string;
  readonly meta: string;
  /** Where the row goes: the composer for a team's draft, else the issue page. */
  readonly open:
    | { readonly kind: 'composer'; readonly teamId: string }
    | { readonly kind: 'issue'; readonly href: string }
    | null;
}

interface Lookup {
  team(id: string): { readonly key: string; readonly name: string } | undefined;
  issue(id: string):
    | {
        readonly lifecycle: 'live' | 'gone';
        readonly identifier: string;
        readonly title: string;
        readonly href: string;
      }
    | undefined;
}

/** The page's rows from the drafts, the replica and the answers so far (pure, tested). */
export function draftLines(
  entries: readonly DraftEntry[],
  lookup: Lookup,
  remote: ReadonlyMap<string, Remote>,
  now: Date,
): DraftLine[] {
  const lines: DraftLine[] = [];
  for (const entry of entries) {
    const saved = `saved ${agoText(entry.row.updatedAt, now)}`;
    if (entry.kind === 'composer') {
      const data = readComposerDraft(entry.row.data);
      const team = lookup.team(entry.teamId);
      lines.push({
        key: entry.row.id,
        entry,
        title: data.title.trim() === '' ? 'Untitled issue' : data.title,
        // E7: a team the user can no longer see isn't named; opening it uses the default team.
        meta: `${team?.key ?? 'A team you can no longer see'} · ${saved}`,
        open: { kind: 'composer', teamId: entry.teamId },
      });
      continue;
    }
    const line = docFirstLine(entry.text);
    const local = lookup.issue(entry.issueId);
    if (local !== undefined) {
      if (local.lifecycle === 'gone') continue;
      lines.push({
        key: entry.row.id,
        entry,
        title: `${local.identifier} ${local.title}`,
        meta: `${line} · ${saved}`,
        open: { kind: 'issue', href: local.href },
      });
      continue;
    }
    const answer = remote.get(entry.issueId);
    if (answer?.kind === 'hidden') continue;
    lines.push({
      key: entry.row.id,
      entry,
      title: answer?.kind === 'live' ? `${answer.identifier} ${answer.title}` : 'Issue not loaded',
      meta: `${line} · ${saved}`,
      open:
        answer?.kind === 'live'
          ? { kind: 'issue', href: issuePath(answer.identifier, answer.title) }
          : null,
    });
  }
  return lines;
}

/**
 * Offline, an answer that said the issue is hidden still holds; a live one may be stale, so the
 * row says "Issue not loaded" again.
 */
function offlineOnly(remote: ReadonlyMap<string, Remote>): ReadonlyMap<string, Remote> {
  return new Map([...remote].filter(([, answer]) => answer.kind === 'hidden'));
}

export function DraftsPage() {
  const app = useApp();
  const api = useIssueApi();
  const navigate = useNavigate();
  const commands = useCommandRegistry();
  const [remote, setRemote] = useState<ReadonlyMap<string, Remote>>(new Map());
  const online = useObserved(useCallback(() => app.readyStore?.connection === 'online', [app]));

  const view = useObserved(
    useCallback(() => {
      const store = app.readyStore;
      if (store === null) return null;
      const entries = draftAdapterFor(store).list();
      const teams = new Map(store.pool.all(Team).map((t) => [t.id, { key: t.key, name: t.name }]));
      const missing: string[] = [];
      const issues: Record<
        string,
        { lifecycle: 'live' | 'gone'; identifier: string; title: string; href: string }
      > = {};
      for (const entry of entries) {
        if (entry.kind !== 'comment') continue;
        const row = store.pool.get(Issue, entry.issueId);
        const team = row === undefined ? undefined : teams.get(row.teamId);
        if (row === undefined || team === undefined) {
          missing.push(entry.issueId);
          continue;
        }
        issues[entry.issueId] = {
          lifecycle: row.archivedAt === null && row.deletedAt === null ? 'live' : 'gone',
          identifier: row.number === null ? `${team.key}-…` : issueIdentifier(team.key, row.number),
          title: row.title,
          href: canonicalIssuePath(row, team.key),
        };
      }
      return { entries, teams: Object.fromEntries(teams), issues, missing };
    }, [app]),
  );

  // E18: ask the server about comment drafts whose issue the replica doesn't hold, when online.
  const missing = view?.missing.join(',') ?? '';
  useEffect(() => {
    // Offline, nothing is asked: the rows say "Issue not loaded" until the connection returns.
    if (missing === '' || !online) return;
    let cancelled = false;
    for (const issueId of missing.split(',')) {
      void api.get(issueId).then((answer) => {
        if (cancelled) return;
        const next: Remote = answer.ok
          ? answer.result.archivedAt === null && answer.result.deletedAt === null
            ? { kind: 'live', identifier: answer.result.identifier, title: answer.result.title }
            : { kind: 'hidden' }
          : answer.code === 'UNREACHABLE'
            ? { kind: 'offline' }
            : { kind: 'hidden' };
        setRemote((before) => new Map(before).set(issueId, next));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [missing, online, api]);

  const store = app.readyStore;
  if (view === null || store === null) return <PageHeader crumbs={['Drafts']} title="Drafts" />;
  const lines = draftLines(
    view.entries,
    {
      team: (id) => view.teams[id],
      issue: (id) => view.issues[id],
    },
    online ? remote : offlineOnly(remote),
    new Date(),
  );

  const openLine = (line: DraftLine) => {
    if (line.open === null) return;
    if (line.open.kind === 'composer') {
      openComposerWith({ kind: 'draft', teamId: line.open.teamId }, (id) => commands.run(id));
    } else {
      // TODO(PLAN-013 S5): the comment box shows the draft (the adapter's `commentText`).
      void navigate({ href: line.open.href });
    }
  };

  return (
    <>
      <PageHeader crumbs={['Drafts']} title="Drafts" />
      <div className={styles.page}>
        {lines.length === 0 ? (
          <EmptyState
            icon={<FilePen />}
            title="No drafts"
            description="Close the composer with Save to keep one here."
          />
        ) : (
          <ul className={styles.list} aria-label="Drafts">
            {lines.map((line) => (
              <li key={line.key} className={styles.row}>
                <button
                  type="button"
                  className={styles.rowMain}
                  aria-disabled={line.open === null || undefined}
                  onClick={() => {
                    openLine(line);
                  }}
                >
                  <span className={styles.rowTitle}>{line.title}</span>
                  <span className={styles.rowMeta}>{line.meta}</span>
                </button>
                <Menu
                  align="end"
                  trigger={
                    <IconButton
                      aria-label={`Actions for ${line.title}`}
                      size="sm"
                      icon={<MoreHorizontal />}
                    />
                  }
                  items={[
                    {
                      type: 'item',
                      label: 'Delete draft',
                      onSelect: () => {
                        draftAdapterFor(store).discard(line.entry);
                      },
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
