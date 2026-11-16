// Shows the open picker (SPEC-012 §3.5) in a popover anchored to what asked for it: a pill, the
// focused row or the properties panel. Mounted once in `SHELL_HOSTS`, so a key handler, a menu
// item and a pill all open pickers the same way (`openPicker`). Closing (a pick, `Enter`, `Esc`,
// a click outside) tells the request, so a list can move focus back to its row.
import { Popover, PopoverAnchor, PopoverContent } from '@surface/ui';
import { useSyncExternalStore } from 'react';
import {
  AssigneePicker,
  DueDatePicker,
  EstimatePicker,
  LabelsPicker,
  PriorityPicker,
  StatusPicker,
  type BoundPickerProps,
} from './BoundPickers.js';
import { pickerRequests, type PickerRequest } from './picker-request.js';

const PICKERS = {
  status: StatusPicker,
  priority: PriorityPicker,
  assignee: AssigneePicker,
  labels: LabelsPicker,
  estimate: EstimatePicker,
  dueDate: DueDatePicker,
} as const satisfies Record<PickerRequest['kind'], (props: BoundPickerProps) => React.ReactNode>;

const LABELS = {
  status: 'Change status',
  priority: 'Set priority',
  assignee: 'Assign to',
  labels: 'Change labels',
  estimate: 'Set estimate',
  dueDate: 'Set due date',
} as const satisfies Record<PickerRequest['kind'], string>;

/** An invisible box over the anchor's rectangle: the popover positions against it. */
function anchorStyle(anchor: Element | null) {
  const rect = anchor?.getBoundingClientRect();
  return {
    position: 'fixed',
    left: rect?.left ?? 0,
    top: rect?.top ?? 0,
    width: rect?.width ?? 0,
    height: rect?.height ?? 0,
    pointerEvents: 'none',
  } as const;
}

export function IssuePickersHost() {
  const request = useSyncExternalStore(
    pickerRequests.subscribe,
    pickerRequests.snapshot,
    pickerRequests.snapshot,
  );
  if (request === undefined) return null;
  const Picker = PICKERS[request.kind];
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) pickerRequests.close();
      }}
    >
      <PopoverAnchor>
        <span aria-hidden="true" style={anchorStyle(request.anchor)} />
      </PopoverAnchor>
      <PopoverContent aria-label={LABELS[request.kind]}>
        <Picker
          // Keyed by request, so a second picker never inherits the first one's search or toggles.
          key={`${request.kind}:${request.issueId}`}
          issueId={request.issueId}
          onClose={() => {
            pickerRequests.close();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
