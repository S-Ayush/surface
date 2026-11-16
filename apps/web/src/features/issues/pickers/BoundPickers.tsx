// The six bound pickers (SPEC-012 §3.5; PLAN-012 S6): each reads the replica for its issue and sends
// one `issue.update` with a partial input. The options come from `issue-pickers.ts`, the same
// ones the command menu offers. A host (the popover in `IssuePickersHost`) closes them with
// `onClose`; the labels picker applies its toggles when it closes, in any way.
import { parseDueDate, PRIORITIES } from '@surface/domain';
import {
  Avatar,
  DatePicker,
  PriorityIcon,
  PropertyPicker,
  StatusIcon,
  type PropertyPickerOption,
} from '@surface/ui';
import { useCallback, type ReactNode } from 'react';
import { useApp, useObserved } from '../../../app/context.js';
import type { ComposerWorld } from '../composer-model.js';
import { readComposerWorld } from '../composer-world.js';
import {
  dueDateInput,
  labelsInput,
  pickerSpec,
  readIssueFacts,
  singleInput,
  type IssueFacts,
  type PickerSpec,
} from '../issue-pickers.js';
import { localToday } from '../useIssueRows.js';
import { sendIssueUpdate } from './send.js';

export interface BoundPickerProps {
  readonly issueId: string;
  /** The host closes its popover. Called after a pick or an apply, and on `Esc`. */
  readonly onClose: () => void;
}

/** The options with the icon each kind shows (status icon, priority bars, avatar). */
export function withPickerIcons(
  spec: PickerSpec,
  world: ComposerWorld,
): readonly PropertyPickerOption[] {
  if (spec.mode === 'date') return [];
  const icon = (id: string): ReactNode => {
    if (spec.kind === 'status') {
      const status = world.statuses.find((s) => s.id === id);
      return status && <StatusIcon category={status.category} color={status.color} />;
    }
    if (spec.kind === 'priority') {
      const priority = PRIORITIES.find((p) => String(p.value) === id);
      return priority && <PriorityIcon priority={priority.value} />;
    }
    if (spec.kind === 'assignee') {
      const user = world.users.find((u) => u.id === id);
      return user && <Avatar name={user.name} size={16} />;
    }
    return undefined;
  };
  return spec.options.map((option) => ({ ...option, icon: icon(option.id) }));
}

/** The issue, its team's world and the picker for `kind`, kept current as deltas arrive. */
function useBoundSpec(kind: PickerSpec['kind'], issueId: string) {
  const app = useApp();
  const read = useCallback(() => {
    const store = app.readyStore;
    const me = app.session?.userId;
    if (store === null || me === undefined) return undefined;
    const facts = readIssueFacts(store.pool, issueId);
    if (facts === undefined) return undefined;
    const world = readComposerWorld(store.pool, me, null, []);
    const spec = pickerSpec(kind, world, facts);
    return spec === undefined ? undefined : { world, spec };
  }, [app, kind, issueId]);
  const current = useObserved(read);
  /** The issue as it is now (a pick is applied to what the replica holds, not to what was shown). */
  const factsNow = (): IssueFacts | undefined => {
    const store = app.readyStore;
    return store === null ? undefined : readIssueFacts(store.pool, issueId);
  };
  const send = (build: (facts: IssueFacts) => ReturnType<typeof singleInput>) => {
    const store = app.readyStore;
    const facts = factsNow();
    if (store === null || facts === undefined) return;
    void sendIssueUpdate(store, build(facts));
  };
  return { current, send };
}

function SingleBound({
  kind,
  issueId,
  onClose,
}: BoundPickerProps & { readonly kind: 'status' | 'priority' | 'assignee' | 'estimate' }) {
  const { current, send } = useBoundSpec(kind, issueId);
  if (current === undefined || current.spec.mode !== 'single') return null;
  const { world, spec } = current;
  return (
    <PropertyPicker
      mode="single"
      label={spec.label}
      value={spec.value}
      options={withPickerIcons(spec, world)}
      onSelect={(id) => {
        send((facts) => singleInput(kind, facts, id));
      }}
      onClose={onClose}
    />
  );
}

export const StatusPicker = (props: BoundPickerProps) => <SingleBound kind="status" {...props} />;
export const PriorityPicker = (props: BoundPickerProps) => (
  <SingleBound kind="priority" {...props} />
);
export const AssigneePicker = (props: BoundPickerProps) => (
  <SingleBound kind="assignee" {...props} />
);
export const EstimatePicker = (props: BoundPickerProps) => (
  <SingleBound kind="estimate" {...props} />
);

export function LabelsPicker({ issueId, onClose }: BoundPickerProps) {
  const { current, send } = useBoundSpec('labels', issueId);
  if (current === undefined || current.spec.mode !== 'multi') return null;
  const { spec } = current;
  return (
    <PropertyPicker
      mode="multi"
      label={spec.label}
      values={spec.values}
      options={spec.options}
      onApply={(ids) => {
        send((facts) => labelsInput(facts, ids));
      }}
      onClose={onClose}
    />
  );
}

export function DueDatePicker({ issueId, onClose }: BoundPickerProps) {
  const { current, send } = useBoundSpec('dueDate', issueId);
  const app = useApp();
  const store = app.readyStore;
  const facts = store === null ? undefined : readIssueFacts(store.pool, issueId);
  if (current === undefined || facts === undefined) return null;
  const today = localToday();
  return (
    <DatePicker
      value={facts.dueDate}
      today={today}
      parse={(text) => parseDueDate(text, today)}
      onChange={(date) => {
        send((now) => dueDateInput(now, date));
      }}
      onClose={onClose}
    />
  );
}
