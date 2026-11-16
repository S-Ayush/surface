import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { cx } from '../../internal/cx.js';
import {
  cellEmoji,
  emojiSections,
  firstCell,
  FREQUENT_STORAGE_KEY,
  moveCell,
  parseFrequentUse,
  recordUse,
  type FrequentUse,
  type GridCell,
  type PickerEmoji,
} from './model.js';
import styles from './EmojiPicker.module.css';

export type { PickerEmoji } from './model.js';

export type EmojiPickerProps = {
  /**
   * The emoji data, loaded on first open. `apps/web` passes the editor's lazy, bundled data
   * (`loadEmoji` from `@surface/editor`, SPEC-013 D22): the picker itself makes no request (AC-16).
   */
  loadEmoji: () => Promise<readonly PickerEmoji[]>;
  /** Called with the chosen emoji; the picker then asks to close. */
  onSelect: (emoji: string) => void;
  /** Called after a pick and on `Esc`: the host closes its popover. */
  onClose?: () => void;
  /** Names the search field and the grid ("Add reaction"). */
  label?: string;
  className?: string;
};

/** The device's emoji use, or none when storage is unavailable (private mode, blocked). */
function readUse(): FrequentUse {
  try {
    return parseFrequentUse(globalThis.localStorage.getItem(FREQUENT_STORAGE_KEY));
  } catch {
    return {};
  }
}

function writeUse(use: FrequentUse): void {
  try {
    globalThis.localStorage.setItem(FREQUENT_STORAGE_KEY, JSON.stringify(use));
  } catch {
    // Storage full or blocked: the pick still counts, only the list isn't remembered.
  }
}

type Loaded =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly emoji: readonly PickerEmoji[] }
  | { readonly state: 'failed' };

const cellKey = (cell: GridCell) => `${String(cell.section)}-${String(cell.index)}`;

/**
 * Choose an emoji (design-system §5.3, SPEC-013 §3.4): a search field, "Frequently used" (kept on
 * this device), then the categories, in a grid. The search field keeps focus; the arrow keys move
 * the highlight through the grid, `Enter` picks, `Esc` closes. The host puts it in a Popover.
 */
export function EmojiPicker({
  loadEmoji,
  onSelect,
  onClose,
  label = 'Choose an emoji',
  className,
}: EmojiPickerProps) {
  const listId = useId();
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [query, setQuery] = useState('');
  const [use, setUse] = useState<FrequentUse>(readUse);
  const [highlight, setHighlight] = useState<GridCell | null>(null);

  // The host passes a module-level loader (one load per page), so this runs once per open.
  useEffect(() => {
    let live = true;
    loadEmoji().then(
      (emoji) => {
        if (live) setLoaded({ state: 'ready', emoji });
      },
      () => {
        if (live) setLoaded({ state: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [loadEmoji]);

  const sections = useMemo(
    () => (loaded.state === 'ready' ? emojiSections(loaded.emoji, query, use) : []),
    [loaded, query, use],
  );
  // The highlight starts on the first cell, and again on each new query.
  const active = highlight ?? firstCell(sections);
  const activeEmoji = cellEmoji(sections, active);
  const activeId = active === null ? undefined : `${listId}-${cellKey(active)}`;

  useEffect(() => {
    if (activeId === undefined) return;
    document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  function choose(emoji: PickerEmoji) {
    const next = recordUse(use, emoji.unicode, Date.now());
    setUse(next);
    writeUse(next);
    onSelect(emoji.unicode);
    onClose?.();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const key = event.key;
    if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
      return;
    }
    if (key === 'Enter') {
      event.preventDefault();
      if (activeEmoji !== undefined) choose(activeEmoji);
      return;
    }
    // Left and right move the caret while there is text to move in, like Linear's picker.
    const caretKey = (key === 'ArrowLeft' || key === 'ArrowRight') && query !== '';
    const homeEnd = (key === 'Home' || key === 'End') && query !== '';
    if (
      !caretKey &&
      !homeEnd &&
      (key === 'ArrowLeft' ||
        key === 'ArrowRight' ||
        key === 'ArrowUp' ||
        key === 'ArrowDown' ||
        key === 'Home' ||
        key === 'End')
    ) {
      event.preventDefault();
      setHighlight(moveCell(sections, active, key));
    }
  }

  return (
    <div className={cx(styles.root, className)}>
      <input
        // Opens with the search field focused, like every picker (SPEC-012 §3.5).
        autoFocus
        role="combobox"
        aria-label={label}
        aria-expanded={sections.length > 0}
        aria-controls={sections.length > 0 ? listId : undefined}
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        className={styles.search}
        placeholder="Search emoji…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(null);
        }}
        onKeyDown={handleKeyDown}
      />
      {loaded.state === 'loading' && (
        <div role="status" className={styles.message}>
          Loading emoji…
        </div>
      )}
      {loaded.state === 'failed' && (
        <div role="alert" className={styles.message}>
          Emoji couldn’t load. Close the picker and open it again.
        </div>
      )}
      {loaded.state === 'ready' && sections.length === 0 && (
        <div role="status" className={styles.message}>
          No emoji match “{query.trim()}”
        </div>
      )}
      {sections.length > 0 && (
        <div id={listId} role="listbox" aria-label={label} className={styles.list}>
          {sections.map((section, s) => {
            const headingId = `${listId}-${section.id}`;
            return (
              <div key={section.id} role="group" aria-labelledby={headingId}>
                <div id={headingId} className={styles.heading}>
                  {section.name}
                </div>
                <div className={styles.grid}>
                  {section.emoji.map((emoji, index) => {
                    const cell = { section: s, index };
                    const highlighted = active?.section === s && active.index === index;
                    return (
                      <div
                        key={emoji.unicode}
                        id={`${listId}-${cellKey(cell)}`}
                        role="option"
                        aria-selected={highlighted}
                        aria-label={emoji.label}
                        data-highlighted={highlighted || undefined}
                        className={styles.cell}
                        // The field keeps focus; the mouse only moves the highlight and picks.
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseMove={() => {
                          if (!highlighted) setHighlight(cell);
                        }}
                        onClick={() => choose(emoji)}
                      >
                        {emoji.unicode}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className={styles.footer} aria-hidden="true">
        {activeEmoji !== undefined && (
          <>
            <span className={styles.preview}>{activeEmoji.unicode}</span>
            <span className={styles.name}>
              {activeEmoji.shortcodes[0] === undefined
                ? activeEmoji.label
                : `:${activeEmoji.shortcodes[0]}:`}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
