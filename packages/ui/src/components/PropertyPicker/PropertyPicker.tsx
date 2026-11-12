import { Check } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../../internal/cx.js';
import { Kbd } from '../Kbd/Kbd.js';
import {
  closeEffects,
  filterOptions,
  initialState,
  onKey,
  setQuery,
  showsQuickKeys,
  toggle,
  type PickerEffect,
  type PickerOption,
  type PickerState,
} from './model.js';
import styles from './PropertyPicker.module.css';

export type { PickerOption } from './model.js';

/** An option with its icon (StatusIcon, Avatar, a label dot …). */
export type PropertyPickerOption = PickerOption & { icon?: ReactNode };

type Common = {
  options: readonly PropertyPickerOption[];
  /** Names the search field and the list ("Change status"). */
  label: string;
  placeholder?: string;
  /** Shown when the query matches nothing. */
  emptyText?: string;
  /** Called after a pick or an apply, and on `Esc`: the host closes its popover or sub-page. */
  onClose?: () => void;
  className?: string;
};

export type PropertyPickerProps = Common &
  (
    | {
        mode: 'single';
        /** The current value's option id: checked, and highlighted first. */
        value: string | null;
        onSelect: (id: string) => void;
      }
    | {
        mode: 'multi';
        /** The ids checked now. */
        values: readonly string[];
        /** Every toggle at once, when the picker closes in any way (`Enter`, `Esc`, outside click). */
        onApply: (ids: readonly string[]) => void;
      }
  );

/**
 * The one picker for every property (design-system §5.3, SPEC-012 §3.5): a search field and a
 * list, using the combobox pattern of the command menu. The host puts it in a Popover, anchored to
 * a pill or a row, or in a command-menu sub-page. Behaviour lives in `model.ts`.
 */
export function PropertyPicker(props: PropertyPickerProps) {
  const { options, label, placeholder = 'Search…', emptyText = 'No matches', className } = props;
  const mode = props.mode;
  const listId = useId();
  const [state, setState] = useState<PickerState>(() =>
    mode === 'single'
      ? initialState(options, [], props.value)
      : initialState(options, props.values),
  );
  // The latest state and props for the unmount cleanup below; written after each render.
  const latest = useRef({ state, props });
  const applied = useRef(false);
  useEffect(() => {
    latest.current = { state, props };
  });
  // A toggle after an apply (the picker stayed mounted) makes the unmount apply again.
  useEffect(() => {
    applied.current = false;
  }, [state.selected]);

  const visible = filterOptions(options, state.query);

  /** Runs the effects; says whether an apply happened, so the unmount cleanup doesn't repeat it. */
  function run(effects: readonly PickerEffect[]): boolean {
    let didApply = false;
    for (const effect of effects) {
      const current = props;
      if (effect.type === 'select' && current.mode === 'single') current.onSelect(effect.id);
      else if (effect.type === 'apply' && current.mode === 'multi') {
        didApply = true;
        current.onApply(effect.ids);
      } else if (effect.type === 'close') current.onClose?.();
    }
    return didApply;
  }

  // A click outside or any other unmount applies the toggles too: there is no cancel (§3.5).
  useEffect(
    () => () => {
      const { state: last, props: current } = latest.current;
      if (current.mode !== 'multi' || applied.current) return;
      for (const effect of closeEffects(last)) {
        if (effect.type === 'apply') current.onApply(effect.ids);
      }
    },
    [],
  );

  useEffect(() => {
    const active =
      state.highlightId === null ? null : document.getElementById(`${listId}-${state.highlightId}`);
    active?.scrollIntoView?.({ block: 'nearest' });
  }, [state.highlightId, listId]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const result = onKey(state, event.key, options, mode);
    if (!result.handled) return;
    event.preventDefault();
    if (event.key === 'Escape') event.stopPropagation();
    setState(result.state);
    if (run(result.effects)) applied.current = true;
  }

  function choose(id: string) {
    if (mode === 'single') {
      run([{ type: 'select', id }, { type: 'close' }]);
    } else {
      const next = toggle(state, options, id);
      setState({ ...next, highlightId: id });
    }
  }

  const showHints = showsQuickKeys(state, mode);
  let lastGroup: string | undefined;
  const rendered: ReactNode[] = [];
  const optionNode = (option: PropertyPickerOption) => {
    const selected =
      mode === 'single'
        ? props.mode === 'single' && props.value === option.id
        : state.selected.includes(option.id);
    return (
      <div
        key={option.id}
        id={`${listId}-${option.id}`}
        role="option"
        aria-selected={selected}
        aria-disabled={option.disabled || undefined}
        data-highlighted={state.highlightId === option.id || undefined}
        className={styles.option}
        // The field keeps focus; the mouse only moves the highlight and picks.
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => {
          if (state.highlightId !== option.id && !option.disabled)
            setState({ ...state, highlightId: option.id });
        }}
        onClick={() => choose(option.id)}
      >
        <span className={cx(styles.check, !selected && styles.unchecked)}>
          <Check aria-hidden="true" />
        </span>
        {option.icon !== undefined && <span className={styles.icon}>{option.icon}</span>}
        <span className={styles.label}>{option.label}</span>
        {showHints && option.quickKey !== undefined && (
          <Kbd keys={option.quickKey} className={styles.hint} aria-hidden="true" />
        )}
      </div>
    );
  };

  // Options of one group sit under one heading (a `group` for assistive technology).
  for (let i = 0; i < visible.length;) {
    const option = visible[i];
    if (!option) break;
    if (option.group !== undefined && option.group !== lastGroup) {
      const group = option.group;
      const members: PropertyPickerOption[] = [];
      while (i < visible.length && visible[i]?.group === group) {
        const member = visible[i];
        if (member) members.push(member);
        i++;
      }
      const headingId = `${listId}-group-${rendered.length}`;
      rendered.push(
        <div key={`group-${group}-${rendered.length}`} role="group" aria-labelledby={headingId}>
          <div id={headingId} className={styles.heading}>
            {group}
          </div>
          {members.map(optionNode)}
        </div>,
      );
      lastGroup = group;
    } else {
      rendered.push(optionNode(option));
      lastGroup = option.group;
      i++;
    }
  }

  return (
    <div className={cx(styles.root, className)}>
      <input
        // The picker opens with the search field focused (SPEC-012 §3.5).
        autoFocus
        role="combobox"
        aria-label={label}
        aria-expanded={visible.length > 0}
        aria-controls={visible.length > 0 ? listId : undefined}
        aria-activedescendant={
          state.highlightId === null ? undefined : `${listId}-${state.highlightId}`
        }
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        className={styles.search}
        placeholder={placeholder}
        value={state.query}
        onChange={(event) => setState(setQuery(state, event.target.value, options))}
        onKeyDown={handleKeyDown}
      />
      {visible.length > 0 ? (
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          aria-multiselectable={mode === 'multi' || undefined}
          className={styles.list}
        >
          {rendered}
        </div>
      ) : (
        <div role="status" className={styles.empty}>
          {emptyText}
        </div>
      )}
    </div>
  );
}
