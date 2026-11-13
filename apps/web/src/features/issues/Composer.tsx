// The composer dialog (SPEC-012 §3.1): team chip, title, the description seam, the property pills
// and the footer. Controlled: `IssuesHost` owns the state, the drafts and what creating does. Pills
// are reached with `Tab` and opened with `Enter` or `Space`; there are no single-letter keys here,
// so typing never triggers one (D13). An open picker takes `Esc` before the dialog does.
import { PRIORITIES, parseDueDate, type Priority } from '@surface/domain';
import {
  Avatar,
  Button,
  DatePicker,
  Dialog,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  PriorityIcon,
  PropertyPicker,
  PropertyPill,
  StatusIcon,
  Switch,
  Tooltip,
  VisuallyHidden,
  type PropertyPickerOption,
} from '@surface/ui';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  changeTeam,
  droppedNote,
  type ComposerState,
  type ComposerWorld,
} from './composer-model.js';
import styles from './composer.module.css';
import {
  assigneeOptions,
  estimateOptions,
  labelOptions,
  NONE,
  priorityOptions,
  statusOptions,
} from './picker-options.js';
import { formatEstimate } from '@surface/domain';
import { localToday } from './useIssueRows.js';

export const TITLE_REQUIRED = 'Title is required.';
export const ADD_A_TITLE = 'Add a title to create the issue';

export interface ComposerProps {
  readonly open: boolean;
  readonly world: ComposerWorld;
  readonly state: ComposerState;
  readonly onChange: (state: ComposerState) => void;
  /** "Dropped: …" under the header, from a team change or a restore. */
  readonly note: string | undefined;
  readonly onNote: (note: string | undefined) => void;
  /** "Draft restored · Discard" shows while true. */
  readonly restored: boolean;
  readonly onDiscardDraft: () => void;
  readonly titleError: string | undefined;
  readonly createMore: boolean;
  readonly onCreateMoreChange: (on: boolean) => void;
  readonly onSubmit: () => void;
  /** Any way of closing (Esc, the close button, a click outside): the host asks about the draft. */
  readonly onRequestClose: () => void;
  readonly onClosed: () => void;
  /** Bumped by the host to move focus back to the title ("Create more", an empty submit). */
  readonly focusTitle: number;
}

export function Composer(props: ComposerProps) {
  const { open, world, state, titleError, createMore } = props;
  const formId = useId();
  const hintId = useId();
  const team = world.teams.find((t) => t.id === state.teamId);
  const empty = state.title.trim() === '';
  const [tip, setTip] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) props.onRequestClose();
      }}
      title="New issue"
      size="lg"
      onClosed={props.onClosed}
      footer={
        <div className={styles.footer}>
          <Switch
            label="Create more"
            checked={createMore}
            onCheckedChange={(on) => {
              props.onCreateMoreChange(on);
            }}
          />
          <Tooltip
            content={ADD_A_TITLE}
            // Controlled throughout: shown on hover or focus only while the title is empty.
            open={empty && tip}
            onOpenChange={setTip}
          >
            <Button
              type="submit"
              form={formId}
              variant="primary"
              shortcut="Mod+Enter"
              // aria-disabled, not disabled: it stays focusable and `dialog.submit` still reaches
              // the form, which then says what is missing (§3.1 item 7).
              aria-disabled={empty || undefined}
              aria-describedby={empty ? hintId : undefined}
            >
              Create issue
            </Button>
          </Tooltip>
          <VisuallyHidden id={hintId}>{ADD_A_TITLE}</VisuallyHidden>
        </div>
      }
    >
      {open && team !== undefined && (
        <ComposerForm {...props} formId={formId} titleError={titleError} />
      )}
    </Dialog>
  );
}

function ComposerForm({
  formId,
  world,
  state,
  onChange,
  note,
  onNote,
  restored,
  onDiscardDraft,
  titleError,
  onSubmit,
  focusTitle,
}: ComposerProps & { readonly formId: string }) {
  const titleRef = useRef<HTMLInputElement>(null);
  const pillsRef = useRef<HTMLDivElement>(null);
  // Focus starts in the title (§3.1 item 1). The child's effect runs before the dialog's focus
  // scope, which then leaves focus where it is.
  useEffect(() => {
    titleRef.current?.focus();
  }, [focusTitle]);
  const team = world.teams.find((t) => t.id === state.teamId);
  if (team === undefined) return null;
  const set = (patch: Partial<ComposerState>) => {
    onChange({ ...state, ...patch });
  };

  const onTitleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.nativeEvent.isComposing) {
      return;
    }
    // `Enter` moves on, never submits (§3.1 item 5). TODO(PLAN-011 S6): to the description.
    event.preventDefault();
    pillsRef.current?.querySelector('button')?.focus();
  };

  return (
    <form
      id={formId}
      className={styles.form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className={styles.teamRow}>
        <PickerPill
          property="Team"
          value={team.key}
          label="Change team"
          picker={(close) => (
            <PropertyPicker
              mode="single"
              label="Change team"
              value={team.id}
              options={[...world.teams]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((t) => ({ id: t.id, label: t.name, keywords: t.key }))}
              onSelect={(id) => {
                const changed = changeTeam(world, state, id);
                onChange(changed.state);
                onNote(droppedNote(changed.dropped));
              }}
              onClose={close}
            />
          )}
        />
        <span aria-hidden="true">›</span>
        <span>New issue</span>
      </div>
      {restored && (
        <p className={styles.restored}>
          Draft restored ·{' '}
          <Button size="sm" variant="ghost" onClick={onDiscardDraft}>
            Discard
          </Button>
        </p>
      )}
      {note !== undefined && (
        <p className={styles.note} role="status">
          {note}
        </p>
      )}
      <Input
        ref={titleRef}
        aria-label="Issue title"
        placeholder="Issue title"
        size="lg"
        value={state.title}
        error={titleError}
        onKeyDown={onTitleKey}
        onChange={(event) => {
          set({ title: event.target.value });
        }}
      />
      {/* TODO(PLAN-011 S6): issue.create description. The SPEC-013 editor goes here, a
          RichTextEditor spreading `webEditorOptions`; the composer owns and normalizes `value`. */}
      <div className={styles.pills} ref={pillsRef}>
        <Pills world={world} state={state} set={set} />
      </div>
    </form>
  );
}

function Pills({
  world,
  state,
  set,
}: {
  world: ComposerWorld;
  state: ComposerState;
  set: (patch: Partial<ComposerState>) => void;
}) {
  const team = world.teams.find((t) => t.id === state.teamId);
  if (team === undefined) return null;
  const statusId = state.statusId ?? team.defaultStatusId;
  const status = world.statuses.find((s) => s.id === statusId);
  const priority: Priority = PRIORITIES.find((p) => p.value === state.priority)?.value ?? 0;
  const assignee = world.users.find((u) => u.id === state.assigneeId);
  const labels = state.labelIds
    .map((id) => world.labels.find((l) => l.id === id))
    .filter((l) => l !== undefined);
  const estimates = estimateOptions(team.estimate);
  const today = localToday();
  return (
    <>
      <PickerPill
        property="Status"
        value={status?.name ?? null}
        icon={status && <StatusIcon category={status.category} color={status.color} />}
        label="Change status"
        picker={(close) => (
          <PropertyPicker
            mode="single"
            label="Change status"
            value={statusId}
            options={withIcons(statusOptions(world.statuses, team.id), (id) => {
              const s = world.statuses.find((x) => x.id === id);
              return s && <StatusIcon category={s.category} color={s.color} />;
            })}
            onSelect={(id) => {
              set({ statusId: id });
            }}
            onClose={close}
          />
        )}
      />
      <PickerPill
        property="Priority"
        value={priority === 0 ? null : (PRIORITIES[priority]?.label ?? null)}
        icon={<PriorityIcon priority={priority} />}
        label="Change priority"
        picker={(close) => (
          <PropertyPicker
            mode="single"
            label="Change priority"
            value={String(priority)}
            options={priorityOptions()}
            onSelect={(id) => {
              set({ priority: Number(id) });
            }}
            onClose={close}
          />
        )}
      />
      <PickerPill
        property="Assignee"
        value={assignee?.name ?? null}
        icon={assignee && <Avatar name={assignee.name} size={16} />}
        label="Assign to"
        picker={(close) => (
          <PropertyPicker
            mode="single"
            label="Assign to"
            value={state.assigneeId ?? NONE}
            options={assigneeOptions(world.users, team, world.members[team.id] ?? [], world.me)}
            onSelect={(id) => {
              set({ assigneeId: id === NONE ? null : id });
            }}
            onClose={close}
          />
        )}
      />
      <PickerPill
        property="Labels"
        value={
          labels.length === 0
            ? null
            : labels.length <= 2
              ? labels.map((l) => l.name).join(', ')
              : `${String(labels.length)} labels`
        }
        label="Change labels"
        picker={(close) => (
          <PropertyPicker
            mode="multi"
            label="Change labels"
            values={state.labelIds}
            options={labelOptions(world.labels, team.id, state.labelIds)}
            onApply={(ids) => {
              set({ labelIds: [...ids] });
            }}
            onClose={close}
          />
        )}
      />
      {estimates.length > 0 && (
        <PickerPill
          property="Estimate"
          value={state.estimate === null ? null : formatEstimate(team.estimate, state.estimate)}
          label="Change estimate"
          picker={(close) => (
            <PropertyPicker
              mode="single"
              label="Change estimate"
              value={state.estimate === null ? NONE : String(state.estimate)}
              options={estimates}
              onSelect={(id) => {
                set({ estimate: id === NONE ? null : Number(id) });
              }}
              onClose={close}
            />
          )}
        />
      )}
      <PickerPill
        property="Due date"
        value={state.dueDate}
        label="Change due date"
        picker={(close) => (
          <DatePicker
            value={state.dueDate}
            today={today}
            parse={(text) => parseDueDate(text, today)}
            onChange={(date) => {
              set({ dueDate: date });
            }}
            onClose={close}
          />
        )}
      />
    </>
  );
}

function withIcons(
  options: readonly PropertyPickerOption[],
  icon: (id: string) => ReactNode,
): PropertyPickerOption[] {
  return options.map((option) => ({ ...option, icon: icon(option.id) }));
}

/** A pill that opens its picker in a popover, anchored to it. */
function PickerPill({
  property,
  value,
  icon,
  label,
  picker,
}: {
  property: string;
  value: string | null;
  icon?: ReactNode;
  label: string;
  picker: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger>
        <PropertyPill property={property} value={value} {...(icon ? { icon } : {})} />
      </PopoverTrigger>
      <PopoverContent aria-label={label}>
        {picker(() => {
          setOpen(false);
        })}
      </PopoverContent>
    </Popover>
  );
}
