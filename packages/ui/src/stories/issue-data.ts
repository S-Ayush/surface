// Sample issue data for stories only (not exported from the package).
import type { GroupableStatus, Priority, StatusCategory } from '@surface/domain';
import type { LabelHue } from '../tokens.gen.js';

export interface SampleStatus extends GroupableStatus {
  color: LabelHue;
}

export const STATUSES: readonly SampleStatus[] = [
  { id: 's1', name: 'Backlog', category: 'backlog', position: 'a0', color: 'gray' },
  { id: 's2', name: 'Todo', category: 'unstarted', position: 'a0', color: 'gray' },
  { id: 's3', name: 'In Progress', category: 'started', position: 'a0', color: 'amber' },
  { id: 's4', name: 'In Review', category: 'started', position: 'a1', color: 'violet' },
  { id: 's5', name: 'Done', category: 'completed', position: 'a0', color: 'green' },
  { id: 's6', name: 'Canceled', category: 'canceled', position: 'a0', color: 'gray' },
];

export const CATEGORIES: readonly StatusCategory[] = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
  'duplicate',
];

export const PRIORITY_VALUES: readonly Priority[] = [0, 1, 2, 3, 4];

export const SAMPLE_LABELS = [
  { id: 'bug', name: 'Bug', color: 'red' },
  { id: 'feature', name: 'Feature', color: 'blue' },
  { id: 'design', name: 'Needs design', color: 'violet' },
] as const satisfies readonly { id: string; name: string; color: LabelHue }[];

const TITLES = [
  'Fix login redirect after the session expires',
  'Add keyboard shortcut for archiving',
  'Sync stalls when the tab sleeps for an hour',
  'Rename "Team" to "Workspace" in the invite email',
  'Dark theme: contrast of disabled buttons',
  'Export issues as CSV',
];

export function sampleTitle(index: number): string {
  return `${TITLES[index % TITLES.length] ?? 'Issue'}`;
}
