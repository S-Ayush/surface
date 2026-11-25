// The command-menu frame for a property picker (command-menu.md §3.5, PLAN-016 D-e): the same bound
// picker the popover shows, as the body of a menu sub-page. Only the frame differs.
import type { ReactNode } from 'react';
import type { PageHost } from '../../../command-menu/model.js';
import type { PickerKind } from '../issue-pickers.js';
import { LIST_PICKERS } from './BoundPickers.js';

/** The due date is a calendar, not a list: it never has a menu page. */
export type MenuPickerKind = Exclude<PickerKind, 'dueDate'>;

export function pickerBody(kind: MenuPickerKind, issueId: string): (host: PageHost) => ReactNode {
  const Picker = LIST_PICKERS[kind];
  return (host) => <Picker issueId={issueId} onClose={host.close} onBack={host.back} />;
}
