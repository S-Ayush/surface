// Command-menu entries for the issue operations (SPEC-011 §6.1, SPEC-005 §4.1). "Create issue…"
// (`issue.create`) opens the composer through the `issue:create` command, the one `C` triggers
// (SPEC-012 §3.6). The composer is PLAN-012 S5, which registers that command's handler; until then
// the command is unavailable, so the menu doesn't offer the entry (`commands.isAvailable`).
// `issue.update` has no `ui`: its commands are SPEC-012 property commands (PLAN-012 S6), below.
// "Delete issue" and "Restore issue" (SPEC-015 §6.1) open the app commands `issue:delete` (the
// confirm dialog, PLAN-012 S6) and `issue:restore` (the restore flow, PLAN-015 S4), the ones
// `Mod+Backspace` and `#` trigger; until those slices register them, the menu doesn't offer them.
// "Permanently delete…" (`issue.purge`, PLAN-015 S2) opens `issue:purge`, PLAN-015 S4's dialog.
import { Team } from '@surface/domain/model';
import type { SyncStore } from '@surface/sync-client';
import type { CommandContext, CommandPage, PageItem } from '../../command-menu/model.js';
import type { OperationCommand } from '../../command-menu/sources/operations.js';
import type { PropertyCommand, PropertyTarget } from '../../command-menu/sources/properties.js';
import { readComposerWorld } from './composer-world.js';
import {
  assignToMeInput,
  labelsInput,
  pickerSpec,
  readIssueFacts,
  singleInput,
  type IssueFacts,
  type PickerKind,
} from './issue-pickers.js';
import { pickerBody } from './pickers/menu-page.js';
import { openPicker } from './pickers/picker-request.js';
import { sendIssueUpdate } from './pickers/send.js';

/** The focused team, for the permission pre-check (any member may create an issue in it). */
function targetTeamRefs({ target }: CommandContext) {
  const id = target.kind === 'team' ? target.ids[0] : undefined;
  return id === undefined ? {} : { team: { id } };
}

/** The focused issue (anyone who can see an issue may delete or restore it). */
function targetIssueRefs({ target }: CommandContext) {
  const id = target.kind === 'issue' ? target.ids[0] : undefined;
  return id === undefined ? {} : { issue: { id } };
}

export const ISSUE_COMMANDS: Readonly<Record<string, OperationCommand>> = {
  'issue.create': { opens: 'issue:create', refs: targetTeamRefs },
  'issue.delete': { opens: 'issue:delete', refs: targetIssueRefs },
  'issue.restore': { opens: 'issue:restore', refs: targetIssueRefs },
  // Admin only (the pre-check hides it from Members); the dialog is PLAN-015 S4's.
  'issue.purge': { opens: 'issue:purge', refs: targetIssueRefs },
};

// ---- Property commands (SPEC-012 §3.8, PLAN-012 S6) ----

/** `ui.available` and `ctx.store` hand the store over as `unknown` / nullable. */
function isSyncStore(value: unknown): value is SyncStore {
  return typeof value === 'object' && value !== null && 'pool' in value && 'dispatch' in value;
}

/** The issues of a target as the replica holds them; undefined when it holds one of them not live. */
function liveIssues(target: PropertyTarget, store: unknown): IssueFacts[] | undefined {
  if (!isSyncStore(store)) return undefined;
  const facts: IssueFacts[] = [];
  for (const id of target.ids) {
    const issue = readIssueFacts(store.pool, id);
    // An archived or deleted issue only has Restore and the copy commands (§3.8, AC-25); one the
    // replica doesn't hold can't be edited here.
    if (issue?.lifecycle !== 'live') return undefined;
    facts.push(issue);
  }
  return facts;
}

const editable = (target: PropertyTarget, store: unknown): boolean =>
  liveIssues(target, store) !== undefined;

const usesEstimates = (target: PropertyTarget, store: unknown): boolean => {
  const issues = liveIssues(target, store);
  if (issues === undefined || !isSyncStore(store)) return false;
  return issues.every((issue) => {
    const team = store.pool.get(Team, issue.teamId);
    return team !== undefined && team.estimateScale !== 'off';
  });
};

/** `{ issue: row }` for the permission pre-check; the target's first issue. */
const issueRefs = ({ target }: CommandContext) => {
  const id = target.kind === 'global' ? undefined : target.ids[0];
  return id === undefined ? {} : { issue: { id } };
};

function currentIssue(ctx: CommandContext): { store: SyncStore; facts: IssueFacts } | undefined {
  const id = ctx.target.kind === 'global' ? undefined : ctx.target.ids[0];
  if (id === undefined || ctx.store === null) return undefined;
  const facts = readIssueFacts(ctx.store.pool, id);
  return facts === undefined ? undefined : { store: ctx.store, facts };
}

/** "ENG-142 · Fix login redirect" and the bound picker, for the issue the menu acts on. */
function pickerFrame(kind: Exclude<PickerKind, 'dueDate'>, ctx: CommandContext) {
  const found = currentIssue(ctx);
  if (found === undefined) return {};
  const { facts, store } = found;
  const key = store.pool.get(Team, facts.teamId)?.key;
  const identifier =
    key === undefined || facts.number === null ? undefined : `${key}-${facts.number}`;
  return {
    chip: identifier === undefined ? facts.title : `${identifier} · ${facts.title}`,
    body: pickerBody(kind, facts.id),
  };
}

/**
 * A command-menu sub-page for a single-value picker or the labels (§3.8): the same options as the
 * anchored picker. Labels toggle one at a time here (the page closes after a pick), so each pick
 * is one `issue.update` with that label added or removed.
 */
function pickerPage(kind: Exclude<PickerKind, 'dueDate'>, title: string, placeholder: string) {
  return (ctx: CommandContext): CommandPage => ({
    title,
    placeholder,
    // The context chip and the picker itself (§3.5): the options below are the fallback list.
    ...pickerFrame(kind, ctx),
    items: (): readonly PageItem[] => {
      const found = currentIssue(ctx);
      const me = ctx.actor?.userId;
      if (found === undefined || me === undefined) return [];
      const { store, facts } = found;
      const spec = pickerSpec(kind, readComposerWorld(store.pool, me, null, []), facts);
      if (spec === undefined || spec.mode === 'date') return [];
      return spec.options.map((option): PageItem => {
        const base = {
          id: `${kind}:${option.id}`,
          keywords: [...(option.keywords === undefined ? [] : [option.keywords])],
        };
        if (spec.mode === 'multi') {
          const applied = spec.values.includes(option.id);
          const group = option.group === undefined ? '' : `${option.group}: `;
          return {
            ...base,
            title: `${group}${option.label}${applied ? ' (applied)' : ''}`,
            run: () => {
              // An exclusive group keeps one label: choosing one drops the group's other (INV-07).
              const kept = spec.values.filter(
                (id) =>
                  id !== option.id &&
                  (applied ||
                    option.exclusiveGroup === undefined ||
                    spec.options.find((o) => o.id === id)?.exclusiveGroup !==
                      option.exclusiveGroup),
              );
              return sendIssueUpdate(
                store,
                labelsInput(facts, facts.labelIds, applied ? kept : [...kept, option.id]),
              );
            },
          };
        }
        const single = spec.kind;
        return {
          ...base,
          title: option.label,
          run: () => sendIssueUpdate(store, singleInput(single, facts, option.id)),
        };
      });
    },
  });
}

/** Where a picker opened from the menu anchors: the panel's pill, else the focused row. */
function menuAnchor(kind: PickerKind): Element | null {
  return (
    document.querySelector(`[data-property="${kind}"]`) ??
    document.querySelector('[data-shortcut-scope="issue"] [role="row"][data-focused]')
  );
}

const common = {
  section: 'settings',
  // PLAN-014: multi-issue targets. Until then an `issues` target would update only `ids[0]`.
  appliesTo: ['issue'],
  refs: issueRefs,
} as const satisfies Pick<PropertyCommand, 'section' | 'appliesTo' | 'refs'>;

export const ISSUE_PROPERTY_COMMANDS: readonly PropertyCommand[] = [
  {
    ...common,
    id: 'prop:issue.status',
    title: 'Change status…',
    keywords: ['state', 'move to', 'todo', 'in progress', 'done'],
    shortcut: 'issue:status',
    available: editable,
    picker: pickerPage('status', 'Change status', 'Change status to…'),
  },
  {
    ...common,
    id: 'prop:issue.priority',
    title: 'Set priority…',
    keywords: ['urgent', 'high', 'medium', 'low'],
    shortcut: 'issue:priority',
    available: editable,
    picker: pickerPage('priority', 'Set priority', 'Set priority to…'),
  },
  {
    ...common,
    id: 'prop:issue.assignee',
    title: 'Assign…',
    keywords: ['assignee', 'owner', 'person'],
    shortcut: 'issue:assignee',
    available: editable,
    picker: pickerPage('assignee', 'Assign', 'Assign to…'),
  },
  {
    ...common,
    id: 'prop:issue.assign-to-me',
    title: 'Assign to me',
    keywords: ['assignee', 'take', 'mine'],
    shortcut: 'issue:assign-to-me',
    available: editable,
    run: (ctx) => {
      const found = currentIssue(ctx);
      const me = ctx.actor?.userId;
      if (found === undefined || me === undefined) return;
      const world = readComposerWorld(found.store.pool, me, null, []);
      return sendIssueUpdate(found.store, assignToMeInput(world, found.facts));
    },
  },
  {
    ...common,
    id: 'prop:issue.labels',
    title: 'Labels…',
    keywords: ['label', 'tag', 'add label', 'remove label'],
    shortcut: 'issue:labels',
    available: editable,
    picker: pickerPage('labels', 'Labels', 'Add or remove a label…'),
  },
  {
    ...common,
    id: 'prop:issue.estimate',
    title: 'Set estimate…',
    keywords: ['points', 'size', 'effort'],
    shortcut: 'issue:estimate',
    available: usesEstimates,
    picker: pickerPage('estimate', 'Set estimate', 'Set estimate to…'),
  },
  {
    ...common,
    id: 'prop:issue.due-date',
    title: 'Set due date…',
    keywords: ['deadline', 'date', 'due'],
    shortcut: 'issue:due-date',
    available: editable,
    // A calendar and a typed date don't fit a list page, so the menu closes and the picker opens
    // anchored to the issue (the page's pill, else the focused row).
    run: (ctx) => {
      const found = currentIssue(ctx);
      if (found === undefined) return;
      openPicker({ kind: 'dueDate', issueId: found.facts.id, anchor: menuAnchor('dueDate') });
    },
  },
  {
    ...common,
    id: 'prop:issue.remove-due-date',
    title: 'Remove due date',
    keywords: ['clear due date', 'no deadline'],
    shortcut: 'issue:remove-due-date',
    // Offered only on an issue that has one.
    available: (target, store) =>
      liveIssues(target, store)?.every((issue) => issue.dueDate !== null) === true,
    run: (ctx) => {
      const found = currentIssue(ctx);
      if (found === undefined || found.facts.dueDate === null) return;
      return sendIssueUpdate(found.store, { issue: found.facts.id, dueDate: null });
    },
  },
];
