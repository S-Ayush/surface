/**
 * The list under the cursor for the slash menu and the emoji autocomplete. The editor keeps
 * focus the whole time (ProseMirror owns the keys, `suggestion.ts`); this only draws the list and
 * takes mouse picks.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { SuggestionState } from './suggestion.js';

interface SuggestionListProps<T> {
  /** Prefix for the ids of the options (`aria-activedescendant` points at one). */
  readonly id: string;
  readonly label: string;
  readonly state: SuggestionState<T> | null;
  readonly itemKey: (item: T) => string;
  readonly renderItem: (item: T) => ReactNode;
  readonly onPick: (item: T, match: SuggestionState<T>['match']) => void;
}

export const optionId = (id: string, index: number): string => `${id}-option-${String(index)}`;

export function SuggestionList<T>({
  id,
  label,
  state,
  itemKey,
  renderItem,
  onPick,
}: SuggestionListProps<T>) {
  const activeRef = useRef<HTMLLIElement | null>(null);
  const index = state?.index;
  useLayoutEffect(() => {
    // jsdom has no scrollIntoView.
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [index]);
  if (state === null || state.items.length === 0) return null;
  return (
    <ul
      id={id}
      role="listbox"
      aria-label={label}
      className="surface-editor-suggest"
      style={{ left: state.anchor.left, top: state.anchor.bottom }}
    >
      {state.items.map((item, position) => (
        <li
          key={itemKey(item)}
          id={optionId(id, position)}
          role="option"
          aria-selected={position === state.index}
          ref={position === state.index ? activeRef : undefined}
          className="surface-editor-suggest-item"
          // The editor keeps focus: a click must not blur it.
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(item, state.match);
          }}
        >
          {renderItem(item)}
        </li>
      ))}
    </ul>
  );
}
