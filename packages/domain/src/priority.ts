/** Issue priority (glossary: Priority). Stored as a small int; 0 = no priority. */
export const PRIORITIES = [
  { value: 0, label: 'No priority' },
  { value: 1, label: 'Urgent' },
  { value: 2, label: 'High' },
  { value: 3, label: 'Medium' },
  { value: 4, label: 'Low' },
] as const;

export type Priority = (typeof PRIORITIES)[number]['value'];

export function priorityLabel(priority: Priority): string {
  return PRIORITIES[priority].label;
}
