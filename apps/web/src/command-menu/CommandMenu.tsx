// The command menu (command-menu.md, SPEC-005 §4): the ARIA combobox pattern over a listbox of
// sections, nested pages with a breadcrumb, a context chip, and the §4 keyboard table.
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Dialog, Kbd, VisuallyHidden, ariaKeyShortcuts, toast, usePlatform } from '@surface/ui';
import type { Frecency } from './frecency.js';
import {
  GLOBAL_TARGET,
  SECTION_LABELS,
  type CommandContext,
  type CommandSource,
  type CommandTarget,
} from './model.js';
import { collect, rankCommands, rankPageItems } from './ranking.js';
import { withIssueFastPath } from './sources/navigation.js';
import { useReactive } from './reactive.js';
import {
  activeIndex,
  execute,
  initialState,
  keyToAction,
  optionHandlers,
  optionsOf,
  reduce,
  revokedDepth,
  toRows,
  type Effect,
  type Frame,
  type Row,
} from './state.js';
import styles from './CommandMenu.module.css';

/** command-menu.md §5: the list is virtualised above 50 rows. */
export const VIRTUALIZE_ABOVE = 50;
const OVERSCAN = 8;
const FALLBACK_ROW_HEIGHT = 32;

export const PERF = {
  openStart: 'command-menu:open-start',
  open: 'command-menu:open',
  filter: 'command-menu:filter',
} as const;

const COMMAND_ERROR = "That command didn't finish. Try again.";

export type CommandMenuProps = {
  open: boolean;
  onClose: () => void;
  sources: readonly CommandSource[];
  /** Builds the context; called inside the reactive computation, so its reads are tracked. */
  context: (target: CommandTarget) => CommandContext;
  target: CommandTarget;
  frecency: Frecency;
  /** Open straight on a page ("Open team…" from O T). */
  initialPage?: (ctx: CommandContext) => Omit<Frame, 'query'> | undefined;
};

export function CommandMenu({ open, onClose, ...props }: CommandMenuProps) {
  // The command chosen with Enter. It runs as the menu starts to close, once focus is back where it
  // was (§3.4; the exit animation does not delay it), so a dialog it opens returns focus there, and focus it moves is not taken back.
  const pending = useRef<Effect | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      onClosed={() => {
        const effect = pending.current;
        pending.current = null;
        if (effect !== null) runSafely(effect);
      }}
      title="Command menu"
      variant="command"
    >
      {/* Mounted with the dialog content, so it stays while the dialog fades out. */}
      <MenuBody
        {...props}
        onRun={(effect) => {
          pending.current = effect;
          onClose();
        }}
      />
    </Dialog>
  );
}

/** The rows to render when virtualised: those in view, plus OVERSCAN either side. */
export function visibleRange(view: {
  scrollTop: number;
  viewport: number;
  rowHeight: number;
  count: number;
}): { first: number; last: number } {
  const height = Math.max(1, view.rowHeight);
  const first = Math.max(0, Math.floor(view.scrollTop / height) - OVERSCAN);
  const last = Math.min(
    view.count,
    Math.ceil((view.scrollTop + view.viewport) / height) + OVERSCAN,
  );
  return { first, last: Math.max(first, last) };
}

/** Runs a command after the menu has closed: a failure is a toast (§3.4). */
function runSafely(effect: Effect): void {
  try {
    const result = effect();
    if (result instanceof Promise) {
      result.catch(() => toast({ tone: 'danger', message: COMMAND_ERROR }));
    }
  } catch {
    toast({ tone: 'danger', message: COMMAND_ERROR });
  }
}

/** Same rows and revoked depth: nothing the view shows changed (rows are rebuilt each run). */
function sameResult(
  a: { rows: readonly Row[]; revoked: number },
  b: { rows: readonly Row[]; revoked: number },
): boolean {
  return (
    a.revoked === b.revoked &&
    a.rows.length === b.rows.length &&
    a.rows.every((row, i) => row.id === b.rows[i]?.id)
  );
}

function Highlight({ text, indices }: { text: string; indices: readonly number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const marked = new Set(indices);
  const parts: ReactNode[] = [];
  let run = '';
  let runMarked = false;
  const flush = (i: number) => {
    if (run === '') return;
    parts.push(
      runMarked ? (
        <mark key={i} className={styles.match}>
          {run}
        </mark>
      ) : (
        run
      ),
    );
    run = '';
  };
  [...text].forEach((char, i) => {
    const isMarked = marked.has(i);
    if (isMarked !== runMarked) {
      flush(i);
      runMarked = isMarked;
    }
    run += char;
  });
  flush(text.length);
  return <>{parts}</>;
}

function MenuBody({
  sources,
  context,
  target,
  frecency,
  initialPage,
  onRun,
}: Omit<CommandMenuProps, 'open' | 'onClose'> & { onRun: (effect: Effect) => void }) {
  const platform = usePlatform();
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [state, dispatch] = useReducer(reduce, undefined, () => {
    const page = initialPage?.(context(target));
    return initialState({
      chip: target.kind !== 'global',
      ...(page ? { page: { ...page, query: '' } } : {}),
    });
  });
  const compute = useCallback(() => {
    const start = performance.now();
    // Backspace on the chip makes commands apply globally (command-menu.md §1).
    const ctx = context(state.chip ? target : GLOBAL_TARGET);
    const page = state.pages.at(-1)?.page;
    const rows = toRows(
      page
        ? rankPageItems(page, state.query)
        : withIssueFastPath(
            rankCommands(collect(sources, ctx), state.query, ctx, frecency),
            state.query,
            ctx,
          ),
    );
    // Read inside the reaction, so a role change closes a page it no longer allows (E4).
    const revoked = revokedDepth(state.pages, ctx);
    // AC-9. The reaction's tracking run repeats the same ranking, so either run is representative.
    performance.clearMeasures(PERF.filter);
    performance.measure(PERF.filter, { start, end: performance.now() });
    return { rows, ctx, revoked };
  }, [context, target, state.chip, state.pages, state.query, sources, frecency]);
  const { rows, ctx, revoked } = useReactive(compute, sameResult);
  const options = optionsOf(rows);
  const active = activeIndex(state, options);
  const activeRow = options[active];
  const optionId = (row: Row) => `${listId}-${row.id}`;
  const sectionId = (section: string) => `${listId}-section-${section}`;

  const revokedTitle = state.pages[revoked]?.command.title;
  useEffect(() => {
    if (revokedTitle === undefined) return;
    dispatch({
      type: 'revoke',
      depth: revoked,
      message: `${revokedTitle} isn't available anymore.`,
    });
  }, [revoked, revokedTitle]);

  useEffect(() => {
    if (performance.getEntriesByName(PERF.openStart).length === 0) return;
    performance.clearMeasures(PERF.open);
    performance.measure(PERF.open, PERF.openStart);
    performance.clearMarks(PERF.openStart);
  }, []);

  /** Runs `row`: the selected option for a key, the clicked one for a click. */
  const perform = (row: Row | undefined, keepOpen: boolean) => {
    const execution = execute(row, keepOpen, ctx);
    switch (execution.kind) {
      case 'none':
        return;
      case 'failed':
        dispatch({ type: 'error', message: COMMAND_ERROR });
        return;
      case 'push':
        frecency.record(execution.record);
        dispatch({ type: 'push', frame: execution.frame });
        return;
      case 'run':
        if (execution.record !== null) frecency.record(execution.record);
        if (execution.keepOpen) attempt(execution.effect);
        else onRun(execution.effect);
    }
  };

  /** Mod+Enter: run and stay open; a failure shows in the menu (a toast would wait for it). */
  const attempt = (effect: Effect) => {
    dispatch({ type: 'error', message: null });
    try {
      const result = effect();
      if (result instanceof Promise) {
        result.catch(() => dispatch({ type: 'error', message: COMMAND_ERROR }));
      }
    } catch {
      dispatch({ type: 'error', message: COMMAND_ERROR });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const mod = platform === 'mac' ? 'meta' : 'ctrl';
    const result = keyToAction(event.nativeEvent, state, rows, mod);
    if (result.kind === 'none') return;
    event.preventDefault();
    if (result.kind === 'run') perform(activeRow, result.keepOpen);
    else dispatch(result.action);
  };

  // Virtualisation (§5): rows share one height, measured from the first rendered row.
  const [scrollTop, setScrollTop] = useState(0);
  const [rowHeight, setRowHeight] = useState(FALLBACK_ROW_HEIGHT);
  const [viewport, setViewport] = useState(0);
  // The list's top padding: rows start below it.
  const [inset, setInset] = useState(0);
  const windowed = rows.length > VIRTUALIZE_ABOVE;
  useLayoutEffect(() => {
    const list = listRef.current;
    const first = list?.querySelector<HTMLElement>('[data-row]');
    if (first && first.offsetHeight > 0) setRowHeight(first.offsetHeight);
    if (list) {
      setViewport(list.clientHeight);
      setInset(Number.parseFloat(getComputedStyle(list).paddingTop) || 0);
    }
  }, [windowed]);
  const activeRowIndex = activeRow ? rows.indexOf(activeRow) : -1;
  // Keep the active option in view, and so in the DOM for aria-activedescendant.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || activeRowIndex < 0) return;
    // The first option also brings its section header (and the padding) into view.
    const top = activeRowIndex <= 1 ? 0 : inset + activeRowIndex * rowHeight;
    const bottom = inset + (activeRowIndex + 1) * rowHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight)
      list.scrollTop = bottom - list.clientHeight;
  }, [activeRowIndex, rowHeight, inset]);
  const { first, last } = windowed
    ? visibleRange({
        scrollTop: Math.max(0, scrollTop - inset),
        viewport: viewport || rowHeight * 12,
        rowHeight,
        count: rows.length,
      })
    : { first: 0, last: rows.length };

  const page = state.pages.at(-1);
  const chipLabel = state.chip && target.kind !== 'global' ? target.label : null;
  const resultsLabel =
    options.length === 0
      ? 'No results'
      : options.length === 1
        ? '1 result'
        : `${options.length} results`;
  const optionIndex = new Map(options.map((row, i) => [row, i]));
  const sections = rows.flatMap((row) => (row.kind === 'header' ? [row.section] : []));

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        {(chipLabel !== null || state.pages.length > 0) && (
          <div className={styles.trail}>
            {chipLabel !== null && <span className={styles.chip}>{chipLabel}</span>}
            {state.pages.map((frame, i) => (
              <span key={i} className={styles.crumb}>
                {(i > 0 || chipLabel !== null) && <span aria-hidden="true">›</span>}
                {frame.page.title}
              </span>
            ))}
          </div>
        )}
        <input
          className={styles.input}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeRow ? optionId(activeRow) : undefined}
          aria-label={page ? page.page.title : 'Command menu'}
          placeholder={page?.page.placeholder ?? 'Type a command or search…'}
          value={state.query}
          onChange={(event) => dispatch({ type: 'query', query: event.target.value })}
          onKeyDown={onKeyDown}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={page ? page.page.title : 'Commands'}
        className={styles.list}
        onScroll={windowed ? (event) => setScrollTop(event.currentTarget.scrollTop) : undefined}
      >
        {windowed && <div className={styles.spacer} style={{ height: first * rowHeight }} />}
        {rows.slice(first, last).map((row) => {
          if (row.kind === 'header') {
            return (
              <div
                key={row.id}
                role="presentation"
                aria-hidden="true"
                className={styles.header}
                data-row
              >
                {SECTION_LABELS[row.section]}
              </div>
            );
          }
          const index = optionIndex.get(row) ?? -1;
          const selected = index === active;
          const title = row.kind === 'command' ? row.entry.command.title : row.entry.item.title;
          const shortcuts = row.kind === 'command' ? (row.entry.command.shortcuts ?? []) : [];
          const single = shortcuts.find((keys) => typeof keys === 'string');
          const hue = row.kind === 'item' ? row.entry.item.hue : undefined;
          const handlers = optionHandlers(row, index, selected, { dispatch, perform });
          return (
            <div
              key={row.id}
              id={optionId(row)}
              role="option"
              aria-selected={selected}
              aria-setsize={options.length}
              aria-posinset={index + 1}
              // The section is announced with each option: its header may be virtualised away.
              aria-describedby={row.kind === 'command' ? sectionId(row.entry.section) : undefined}
              aria-keyshortcuts={
                single === undefined ? undefined : ariaKeyShortcuts(single, platform)
              }
              className={styles.option}
              data-row
              onMouseMove={handlers.onMouseMove}
              onMouseDown={(event) => event.preventDefault()}
              onClick={handlers.onClick}
            >
              {hue !== undefined && (
                <span
                  className={styles.dot}
                  style={{ background: `var(--label-${hue})` }}
                  aria-hidden="true"
                />
              )}
              <span className={styles.title}>
                <Highlight text={title} indices={row.entry.indices} />
              </span>
              {shortcuts.length > 0 && (
                <span className={styles.keys} aria-hidden="true">
                  {shortcuts.map((keys, i) => (
                    <Kbd key={i} keys={keys} />
                  ))}
                </span>
              )}
            </div>
          );
        })}
        {windowed && (
          <div className={styles.spacer} style={{ height: (rows.length - last) * rowHeight }} />
        )}
      </div>
      {/* Outside the listbox, which may own options only (axe aria-required-children). */}
      {options.length === 0 && (
        <p className={styles.empty}>
          {page && state.query === '' && page.page.empty ? page.page.empty : 'No results'}
        </p>
      )}
      {state.error !== null && (
        <p role="alert" className={styles.error}>
          {state.error}
        </p>
      )}
      <VisuallyHidden>
        <p role="status">{resultsLabel}</p>
        {sections.map((section) => (
          <span key={section} id={sectionId(section)}>
            {SECTION_LABELS[section]}
          </span>
        ))}
      </VisuallyHidden>
      <div className={styles.footer} aria-hidden="true">
        <span>
          <Kbd keys="ArrowUp" />
          <Kbd keys="ArrowDown" /> navigate
        </span>
        <span>
          <Kbd keys="Enter" /> select
        </span>
        {state.pages.length > 0 && (
          <span>
            <Kbd keys="Backspace" /> back
          </span>
        )}
        <span>
          <Kbd keys="Esc" /> close
        </span>
      </div>
    </div>
  );
}
