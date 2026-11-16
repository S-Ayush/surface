/**
 * Activity lines of issue history entries (SPEC-011 §4.4, D9; PLAN-011 S6). The wording is
 * Linear's. The §4.4 table fixes: created, moved from A to B, self-assigned, assigned to B,
 * removed assignee, deleted, restored, automatically archived and automatically closed, and the
 * "via API" / "via MCP" suffix after the name. SPEC-012 words the other fields in the same style
 * and owns them (PLAN-012 S4b); until it does, they read as below.
 *
 * Names come from the entry (snapshotted when it was written, E16); only the actor's name is the
 * caller's, read from the replica by `actorId`.
 */
import type { HistoryActorKind, IssueHistoryKind } from './issue.js';
import { parseHistoryChanges } from './issue-history.js';
import { PRIORITIES } from './priority.js';

/** What the formatter reads of an entry. */
export interface ActivityEntry {
  readonly kind: IssueHistoryKind | (string & {});
  readonly actorKind: HistoryActorKind;
  readonly actorId: string | null;
  readonly changes: unknown;
}

/** "Ada", "Ada via API" or "Ada via MCP" (§4.4). */
export function activityActor(actorName: string, actorKind: HistoryActorKind): string {
  if (actorKind === 'api') return `${actorName} via API`;
  if (actorKind === 'mcp') return `${actorName} via MCP`;
  return actorName;
}

function names(labels: readonly { readonly name: string }[]): string {
  return labels.map((l) => l.name).join(', ');
}

function priorityName(value: number): string {
  return PRIORITIES.find((p) => p.value === value)?.label ?? String(value);
}

/**
 * The lines of one entry, in field order: one per changed field of an `updated` entry, one for
 * every other kind. `actorName` is the actor's name (ignored for the system's own lines).
 */
export function activityLines(entry: ActivityEntry, actorName: string): string[] {
  const who = activityActor(actorName, entry.actorKind);
  const system = entry.actorKind === 'system';
  switch (entry.kind) {
    case 'created':
      return [`${who} created the issue`];
    case 'deleted':
      return [`${who} deleted the issue`];
    case 'restored':
      return [`${who} restored the issue`];
    case 'archived':
      return [system ? 'Issue was automatically archived' : `${who} archived the issue`];
    case 'updated':
      break;
    default:
      return [`${who} updated the issue`];
  }

  const changes = parseHistoryChanges(entry.changes);
  const lines: string[] = [];
  if (changes.title) lines.push(`${who} changed the title to ${changes.title.to}`);
  if (changes.status) {
    const { from, to } = changes.status;
    // The only status change the system makes is the auto-close job's (SPEC-015 §4.8).
    if (system) lines.push('Issue was automatically closed');
    else if (from) lines.push(`${who} moved from ${from.name} to ${to.name}`);
    else lines.push(`${who} moved the issue to ${to.name}`);
  }
  if (changes.priority) {
    const to = changes.priority.to;
    lines.push(to === 0 ? `${who} removed priority` : `${who} set priority to ${priorityName(to)}`);
  }
  if (changes.assignee) {
    const to = changes.assignee.to;
    if (to === null) lines.push(`${who} removed assignee`);
    else if (to.id === entry.actorId) lines.push(`${who} self-assigned the issue`);
    else lines.push(`${who} assigned the issue to ${to.name}`);
  }
  if (changes.labels) {
    const added = 'added' in changes.labels ? changes.labels.added : changes.labels.to;
    const removed = 'removed' in changes.labels ? changes.labels.removed : [];
    if (added.length > 0) {
      lines.push(`${who} added ${added.length === 1 ? 'label' : 'labels'} ${names(added)}`);
    }
    if (removed.length > 0) {
      lines.push(`${who} removed ${removed.length === 1 ? 'label' : 'labels'} ${names(removed)}`);
    }
  }
  if (changes.estimate) {
    const to = changes.estimate.to;
    lines.push(to === null ? `${who} removed the estimate` : `${who} set the estimate to ${to}`);
  }
  if (changes.dueDate) {
    const to = changes.dueDate.to;
    lines.push(to === null ? `${who} removed the due date` : `${who} set the due date to ${to}`);
  }
  if (changes.description) lines.push(`${who} updated the description`);
  return lines.length > 0 ? lines : [`${who} updated the issue`];
}
