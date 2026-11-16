// The virtualised issue list that the team list and My issues share (SPEC-012 §3.3, §7.4): a
// treegrid of group headers and rows, one roving focus, the `list` scope keys, the row menu frame
// and focus memory. The page decides which groups it shows (`useIssueRows`) and what surrounds it.
import { issuePath } from '@surface/domain';
import { User } from '@surface/domain/model';
import {
  ContextMenu,
  GROUP_HEADER_HEIGHT,
  GroupHeader,
  IssueRow,
  ROW_HEIGHT,
  ROW_HEIGHT_COMPACT,
  StatusIcon,
  VirtualList,
  type MenuEntry,
  type VirtualItemProps,
  type VirtualListHandle,
} from '@surface/ui';
import { useNavigate } from '@tanstack/react-router';
import {
  Calendar,
  Copy,
  Gauge,
  SignalHigh,
  Tag,
  Trash2,
  User as UserIcon,
  CircleDot,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type ReactNode,
} from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { useCommandContext } from '../../command-menu/context.js';
import { shortcutsFor } from '../../command-menu/sources/shortcuts.js';
import type { CommandId } from '../../commands/catalog.js';
import { useCommand, useCommandRegistry } from '../../shortcuts/ShortcutProvider.js';
import { announce } from './announcer.js';
import { browserStorage, readCollapse, writeCollapse } from './collapse-state.js';
import { COPY_ITEMS, planCopy, runCopy } from './copy-actions.js';
import { askDelete } from './delete-flow.js';
import {
  EDIT_TITLE_STATE_KEY,
  LIST_SOURCE_STATE_KEY,
  focusMemory,
  resolveFocus,
  type IssueListSource,
} from './focus-model.js';
import { openComposerWith } from './composer-request.js';
import { readIssueFacts, type PickerKind } from './issue-pickers.js';
import { openPicker } from './pickers/picker-request.js';
import { useIssueCommands, type IssueSubject } from './useIssueCommands.js';
import styles from './IssueList.module.css';
import {
  flattenGroups,
  isCollapsed,
  orderedIssueIds,
  type CollapseState,
  type ListGroup,
  type ListItem,
  type ListRow,
} from './list-model.js';

export type IssueListProps = {
  /** Names the grid: "Issues in ENG". */
  ariaLabel: string;
  /** Focus memory and collapse state live under this key (the route, plus the tab). */
  listKey: string;
  /** The list's own address: where `Esc` on the issue page comes back to. */
  href: string;
  groups: readonly ListGroup[];
};

const COMPACT_QUERY = '(max-width: 767.98px)';

function subscribeCompact(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(COMPACT_QUERY);
  query.addEventListener('change', onChange);
  return () => {
    query.removeEventListener('change', onChange);
  };
}

/** Below 768 px rows are compact (NFR-20). */
function useCompact(): boolean {
  return useSyncExternalStore(
    subscribeCompact,
    () => typeof window.matchMedia === 'function' && window.matchMedia(COMPACT_QUERY).matches,
    () => false,
  );
}

/**
 * Makes the focused row the command target (`Mod+K`'s context chip and property commands), while
 * it is mounted. A component, not a hook call in the list: a header has focus too, and then the
 * page's own target (the team) must stay.
 */
function RowTarget({ id, label }: { id: string; label: string }) {
  useCommandContext({ kind: 'issue', ids: [id], label }, 'focus');
  return null;
}

type Focus = { readonly id: string | null; readonly order: readonly string[] };

export function IssueList({ ariaLabel, listKey, href, groups }: IssueListProps) {
  const app = useApp();
  const commands = useCommandRegistry();
  const navigate = useNavigate();
  const compact = useCompact();
  const listRef = useRef<VirtualListHandle>(null);
  const hasFocus = useRef(false);
  const scrollTop = useRef(0);

  const [collapse, setCollapse] = useState<CollapseState>(() =>
    readCollapse(browserStorage(), listKey),
  );
  const items = useMemo(() => flattenGroups(groups, collapse), [groups, collapse]);
  const ids = useMemo(() => items.map((item) => item.id), [items]);

  // Focus is an id, so it follows its issue across live re-sorts (E1) and, when the issue leaves,
  // moves to its neighbour (E2). Derived during render from the previous order, so the pinned row
  // is right on the very render that changes the list.
  const [focus, setFocus] = useState<Focus>(() => ({
    id: focusMemory.restore(listKey, ids),
    order: ids,
  }));
  if (focus.order !== ids) {
    setFocus({ id: resolveFocus(focus.order, ids, focus.id), order: ids });
  }
  const focusedId = focus.id;
  const focusedIndex = focusedId === null ? -1 : ids.indexOf(focusedId);
  const focusedIndexRef = useRef(focusedIndex);
  useEffect(() => {
    focusedIndexRef.current = focusedIndex;
  });
  const [initialScrollTop] = useState(() => focusMemory.recall(listKey)?.scrollTop ?? 0);

  // Announce when the focused issue left the list (E2). Collapsing a group isn't a removal: the
  // check is against every issue the groups hold.
  const known = useRef(new Map<string, string>());
  // The focus before this commit: updated by the effect below, after the check reads it.
  const focusedRef = useRef(focusedId);
  useEffect(() => {
    const now = new Map(
      groups.flatMap((group) => group.rows.map((row) => [row.issueId, row.identifier] as const)),
    );
    const focused = focusedRef.current;
    const gone = focused === null ? undefined : known.current.get(focused);
    if (focused !== null && gone !== undefined && !now.has(focused)) {
      announce(`${gone} was removed`);
    }
    known.current = now;
  }, [groups]);
  useEffect(() => {
    focusedRef.current = focusedId;
  });

  // Remember focus and scroll for the route (§3.3 item 8).
  useEffect(() => {
    if (focusedId !== null) {
      focusMemory.remember(listKey, { focusedId, order: ids, scrollTop: scrollTop.current });
    }
  }, [focusedId, ids, listKey]);
  useEffect(
    () => () => {
      const remembered = focusMemory.recall(listKey);
      if (remembered !== undefined) {
        focusMemory.remember(listKey, { ...remembered, scrollTop: scrollTop.current });
      }
    },
    [listKey],
  );

  // What the list showed on its first render: the effect below runs once, on mount.
  const arrival = useRef({ ids, focusedId });
  // On arrival (a link, `G E`, a return from the issue page) the list takes focus, on the
  // remembered row or the first one, so the `list` scope is active and `J`/`K` work at once
  // (§3.3 item 8). Not while the user is typing in a field.
  useEffect(() => {
    const active = document.activeElement;
    const typing =
      active instanceof HTMLElement &&
      (active.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName));
    if (typing) return;
    hasFocus.current = true;
    const { ids: order, focusedId: remembered } = arrival.current;
    const first = order[0];
    if (remembered === null && first !== undefined) setFocus({ id: first, order });
  }, []);

  // Keep DOM focus on the focused row while the user is in the list: the virtual list reuses
  // elements by index, so after a re-sort the focused element would show another issue.
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusedIndex < 0 || !hasFocus.current) return;
    listRef.current?.scrollToIndex(focusedIndex);
    const element = grid.current?.querySelector<HTMLElement>(
      `[role="row"][aria-rowindex="${String(focusedIndex + 1)}"]`,
    );
    if (element !== null && element !== undefined && element !== document.activeElement) {
      element.focus({ preventScroll: true });
    }
  }, [focusedIndex, ids]);

  const persist = useCallback(
    (next: CollapseState) => {
      setCollapse(next);
      writeCollapse(browserStorage(), listKey, next);
    },
    [listKey],
  );
  const toggleGroup = useCallback(
    (group: ListGroup) => {
      persist({ ...collapse, [group.key]: !isCollapsed(collapse, group) });
    },
    [collapse, persist],
  );

  const open = useCallback(
    (row: ListRow, editTitle = false) => {
      const source: IssueListSource = {
        href,
        routeKey: listKey,
        issueIds: orderedIssueIds(groups),
      };
      void navigate({
        href: row.pending ? `/issue/${row.issueId}` : issuePath(row.identifier, row.title),
        state: (previous) => ({
          ...previous,
          [LIST_SOURCE_STATE_KEY]: source,
          // `Shift+R` opens the page with the title in edit mode (SPEC-012 §3.6).
          ...(editTitle ? { [EDIT_TITLE_STATE_KEY]: true } : {}),
        }),
      });
    },
    [groups, href, listKey, navigate],
  );

  const move = (delta: 1 | -1) => {
    if (ids.length === 0) return;
    const next = focusedIndex < 0 ? 0 : Math.min(ids.length - 1, Math.max(0, focusedIndex + delta));
    hasFocus.current = true;
    setFocus({ id: ids[next] ?? null, order: ids });
  };

  const focusedItem: ListItem | undefined = items[focusedIndex];

  // The issue commands (SPEC-012 §3.6, PLAN-012 S6) act on the focused row.
  const subjectOf = (row: ListRow): IssueSubject => {
    const facts =
      app.readyStore === null ? undefined : readIssueFacts(app.readyStore.pool, row.issueId);
    return {
      id: row.issueId,
      identifier: row.pending ? null : row.identifier,
      title: row.title,
      teamKey: row.identifier.slice(0, row.identifier.lastIndexOf('-')),
      lifecycle: facts?.lifecycle ?? 'live',
      // A row the replica doesn't hold (the archive pages read the server) can't be edited here.
      editable: facts?.lifecycle === 'live',
    };
  };
  const focusedRow = focusedItem?.kind === 'row' ? focusedItem.row : undefined;
  const rowElement = (issueId: string): Element | null => {
    const index = ids.indexOf(issueId);
    return index < 0
      ? null
      : (grid.current?.querySelector(`[role="row"][aria-rowindex="${String(index + 1)}"]`) ?? null);
  };
  /** After a picker or the delete dialog: focus goes back to the focused row (SPEC-012 §3.5). */
  const refocusRow = useCallback(() => {
    hasFocus.current = true;
    // After Radix has restored focus itself (it does so in a timeout of its own).
    window.setTimeout(() => {
      const element = grid.current?.querySelector<HTMLElement>(
        `[role="row"][aria-rowindex="${String(focusedIndexRef.current + 1)}"]`,
      );
      element?.focus({ preventScroll: true });
    }, 0);
  }, []);
  useIssueCommands(() => (focusedRow === undefined ? undefined : subjectOf(focusedRow)), {
    anchor: () => (focusedRow === undefined ? null : rowElement(focusedRow.issueId)),
    onOverlayClosed: refocusRow,
    rename: () => {
      if (focusedRow !== undefined) open(focusedRow, true);
    },
  });
  useCommand('list:next', () => {
    move(1);
  });
  useCommand('list:previous', () => {
    move(-1);
  });
  useCommand('list:open', () => {
    // Enter on a group header is deliberately unbound (`T` toggles it, design-system §5.3).
    if (focusedItem?.kind === 'row') open(focusedItem.row);
  });
  useCommand('list:toggle-group', () => {
    if (focusedItem?.kind === 'header') toggleGroup(focusedItem.group);
  });
  useCommand('list:toggle-all-groups', () => {
    const anyOpen = groups.some((group) => !isCollapsed(collapse, group));
    persist({ ...collapse, ...Object.fromEntries(groups.map((group) => [group.key, anyOpen])) });
    // Rows may vanish under focus: the header of the focused row's group takes it (collapsed).
    if (anyOpen && focusedItem?.kind === 'row') {
      const group = groups.find((g) => g.rows.some((r) => r.issueId === focusedItem.id));
      if (group !== undefined) setFocus({ id: `group:${group.key}`, order: focus.order });
    }
  });

  const itemHeight = useCallback(
    (index: number) => {
      const item = items[index];
      if (item?.kind === 'header') return GROUP_HEADER_HEIGHT;
      return compact ? ROW_HEIGHT_COMPACT : ROW_HEIGHT;
    },
    [items, compact],
  );
  const isHeader = useCallback((index: number) => items[index]?.kind === 'header', [items]);

  const displayName = (): string => {
    const store = app.readyStore;
    const userId = app.session?.userId;
    if (store === null || userId === undefined) return '';
    return store.pool.get(User, userId)?.displayName ?? '';
  };

  /** The key hint of a command, only once the build binds it (a hint never names a dead key). */
  const keyHint = (command: CommandId): { shortcut: string | readonly string[] } | undefined => {
    const keys = shortcutsFor(command)[0];
    return keys === undefined ? undefined : { shortcut: keys };
  };

  const rowMenu = (row: ListRow): MenuEntry[] => {
    const subject = subjectOf(row);
    const copy: MenuEntry = {
      type: 'submenu',
      label: 'Copy',
      icon: <Copy aria-hidden="true" />,
      items: COPY_ITEMS.map((item) => ({
        type: 'item',
        label: item.label,
        onSelect: () => {
          void runCopy(
            planCopy(item.kind, subject, window.location.origin, displayName()),
            typeof navigator === 'undefined' ? undefined : navigator.clipboard,
          );
        },
      })),
    };
    // An issue the replica doesn't hold, or an archived or deleted one, only copies (§3.8).
    if (!subject.editable) return [copy];
    const picker = (
      label: string,
      kind: PickerKind,
      command: CommandId,
      icon: ReactNode,
    ): MenuEntry => ({
      type: 'item',
      label,
      icon,
      ...keyHint(command),
      // After the menu has closed, so its focus return doesn't take focus from the picker.
      onSelect: () => {
        window.setTimeout(() => {
          openPicker({
            kind,
            issueId: row.issueId,
            anchor: rowElement(row.issueId),
            onClosed: refocusRow,
          });
        }, 0);
      },
    });
    return [
      picker('Status', 'status', 'issue:status', <CircleDot aria-hidden="true" />),
      picker('Priority', 'priority', 'issue:priority', <SignalHigh aria-hidden="true" />),
      picker('Assignee', 'assignee', 'issue:assignee', <UserIcon aria-hidden="true" />),
      picker('Labels', 'labels', 'issue:labels', <Tag aria-hidden="true" />),
      // Hidden while the team doesn't use estimates: the row has no estimate cell either.
      ...(row.estimate === undefined
        ? []
        : [picker('Estimate', 'estimate', 'issue:estimate', <Gauge aria-hidden="true" />)]),
      picker('Due date', 'dueDate', 'issue:due-date', <Calendar aria-hidden="true" />),
      { type: 'separator' },
      copy,
      ...(subject.identifier === null
        ? []
        : ([
            { type: 'separator' },
            {
              type: 'item',
              label: 'Delete',
              icon: <Trash2 aria-hidden="true" />,
              ...keyHint('issue:delete'),
              onSelect: () => {
                askDelete({
                  issueId: row.issueId,
                  identifier: subject.identifier ?? '',
                  title: row.title,
                  onClosed: refocusRow,
                });
              },
            },
          ] satisfies MenuEntry[])),
    ];
  };

  // The `+` shows once PLAN-012 S5's composer registers `issue:create` (no dead button before).
  const addAvailable = useObserved(
    useCallback(() => commands.isAvailable('issue:create'), [commands]),
  );

  const renderItem = ({ index, style, tabIndex }: VirtualItemProps) => {
    const item = items[index];
    if (item === undefined) return null;
    const focused = item.id === focusedId;
    if (item.kind === 'header') {
      const { group } = item;
      return (
        <GroupHeader
          key={item.id}
          name={group.name}
          count={group.rows.length}
          icon={<StatusIcon category={group.category} color={group.color} />}
          collapsed={isCollapsed(collapse, group)}
          onToggle={() => {
            setFocus({ id: item.id, order: ids });
            toggleGroup(group);
          }}
          {...(addAvailable
            ? {
                onAdd: () => {
                  // The composer opens with the group's status (and the user, on Assigned).
                  openComposerWith({ kind: 'group', add: group.add }, (id) => commands.run(id));
                },
              }
            : {})}
          rowIndex={index + 1}
          tabIndex={tabIndex}
          focused={focused}
          style={style}
        />
      );
    }
    const { row } = item;
    return (
      <ContextMenu key={item.id} items={rowMenu(row)}>
        <div role="none" style={style} data-shortcut-scope="issue">
          <IssueRow
            rowIndex={index + 1}
            identifier={row.identifier}
            title={row.title}
            priority={row.priority}
            status={row.status}
            labels={row.labels}
            {...(row.estimate === undefined ? {} : { estimate: row.estimate })}
            dueDate={row.dueDate}
            assignee={row.assignee}
            createdLabel={row.createdLabel}
            compact={compact}
            pending={row.pending}
            focused={focused}
            tabIndex={tabIndex}
            style={{ height: '100%' }}
            onOpen={() => {
              open(row);
            }}
            // The pills open their pickers (§3.3 item 5), on an issue the user can edit.
            {...(subjectOf(row).editable
              ? {
                  onPropertyClick: (property: PickerKind, anchor: HTMLElement) => {
                    openPicker({
                      kind: property,
                      issueId: row.issueId,
                      anchor,
                      onClosed: refocusRow,
                    });
                  },
                }
              : {})}
          />
        </div>
      </ContextMenu>
    );
  };

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    hasFocus.current = true;
    const rowIndex = event.target.closest('[role="row"]')?.getAttribute('aria-rowindex');
    const id = rowIndex === null || rowIndex === undefined ? undefined : ids[Number(rowIndex) - 1];
    if (id !== undefined && id !== focusedId) setFocus({ id, order: ids });
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    // Focus moving into a picker, the delete dialog or a menu keeps the list "focused": it takes
    // focus back when that closes (SPEC-012 §3.5), and a removed row's neighbour gets it (E2).
    const intoOverlay =
      next instanceof Element &&
      next.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null;
    if (!event.currentTarget.contains(next) && !intoOverlay) hasFocus.current = false;
  };

  return (
    // The `list` scope is read from the focused element's ancestors (shortcuts §2).
    <div
      ref={grid}
      className={styles.list}
      data-shortcut-scope="list"
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {focusedRow !== undefined && (
        <RowTarget id={focusedRow.issueId} label={focusedRow.identifier} />
      )}
      <VirtualList
        ref={listRef}
        aria-label={ariaLabel}
        count={items.length}
        itemHeight={itemHeight}
        isHeader={isHeader}
        renderItem={renderItem}
        pinnedIndex={focusedIndex < 0 ? null : focusedIndex}
        initialScrollTop={initialScrollTop}
        onScrollTopChange={(top) => {
          scrollTop.current = top;
        }}
      />
    </div>
  );
}
