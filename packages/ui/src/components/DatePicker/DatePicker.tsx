import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from '../../internal/cx.js';
import { Button } from '../Button/Button.js';
import { IconButton } from '../IconButton/IconButton.js';
import { addDays, addMonths, fullDate, monthTitle, monthWeeks, weekdayNames } from './calendar.js';
import styles from './DatePicker.module.css';

export type DatePickerProps = {
  /** The due date, `YYYY-MM-DD`, or null. */
  value: string | null;
  /** Today in the user's calendar, `YYYY-MM-DD`: passed in so the picker stays pure. */
  today: string;
  /** A picked date, or null for "No due date". */
  onChange: (date: string | null) => void;
  /** Reads typed text ("tomorrow") into a `YYYY-MM-DD` date, or null (`parseDueDate` from the domain). */
  parse: (text: string) => string | null;
  /** Called after a change, so the host can close. */
  onClose?: () => void;
  /** A BCP 47 tag for month and weekday names. Defaults to the browser's language. */
  locale?: string;
  className?: string;
};

const ARROW_STEPS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
};

/**
 * The due-date picker (design-system §5.3, SPEC-012 §3.5): a typed-date field that calls `parse`,
 * and a month calendar with arrow-key navigation. Names come from `Intl.DateTimeFormat`.
 */
export function DatePicker({
  value,
  today,
  onChange,
  parse,
  onClose,
  locale,
  className,
}: DatePickerProps) {
  const inputId = useId();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState(false);
  const [cursor, setCursor] = useState(value ?? today);
  const grid = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);

  const weeks = useMemo(() => monthWeeks(cursor), [cursor]);
  const weekdays = useMemo(() => weekdayNames(locale), [locale]);
  const parsed = text.trim() === '' ? null : parse(text);

  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    grid.current?.querySelector<HTMLElement>('button[tabindex="0"]')?.focus();
  }, [cursor]);

  function pick(date: string | null) {
    onChange(date);
    onClose?.();
  }

  function submitText() {
    if (text.trim() === '') return;
    if (parsed === null) setProblem(true);
    else pick(parsed);
  }

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const days = ARROW_STEPS[event.key];
    let next: string | null = null;
    if (days !== undefined) next = addDays(cursor, days);
    else if (event.key === 'PageDown') next = addMonths(cursor, event.shiftKey ? 12 : 1);
    else if (event.key === 'PageUp') next = addMonths(cursor, event.shiftKey ? -12 : -1);
    if (next === null) return;
    event.preventDefault();
    moveFocus.current = true;
    setCursor(next);
  }

  const title = monthTitle(cursor, locale);
  return (
    <div className={cx(styles.root, className)}>
      <input
        id={inputId}
        autoFocus
        aria-label="Due date"
        aria-describedby={`${inputId}-status`}
        aria-invalid={problem || undefined}
        autoComplete="off"
        spellCheck={false}
        className={styles.input}
        placeholder="Try tomorrow or next friday"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setProblem(false);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            submitText();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveFocus.current = true;
            setCursor(parsed ?? cursor);
            // The cursor may not change; focus the day then.
            grid.current?.querySelector<HTMLElement>('button[tabindex="0"]')?.focus();
          }
        }}
      />
      <div
        id={`${inputId}-status`}
        role="status"
        className={cx(styles.status, problem && styles.problem)}
      >
        {problem
          ? 'Not a date. Try tomorrow, next friday or 2026-12-03.'
          : parsed !== null
            ? fullDate(parsed, locale)
            : ''}
      </div>
      <div className={styles.header}>
        <IconButton
          size="sm"
          aria-label="Previous month"
          icon={<ChevronLeft />}
          onClick={() => setCursor(addMonths(cursor, -1))}
        />
        <div className={styles.title} aria-live="polite">
          {title}
        </div>
        <IconButton
          size="sm"
          aria-label="Next month"
          icon={<ChevronRight />}
          onClick={() => setCursor(addMonths(cursor, 1))}
        />
      </div>
      <div
        ref={grid}
        role="grid"
        aria-label={title}
        className={styles.grid}
        onKeyDown={onGridKeyDown}
      >
        <div role="row" className={styles.week}>
          {weekdays.map((name) => (
            <div
              key={name.long}
              role="columnheader"
              aria-label={name.long}
              className={styles.weekday}
            >
              {name.short.slice(0, 2)}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]?.date} role="row" className={styles.week}>
            {week.map((day) => (
              <div key={day.date} role="gridcell" aria-selected={day.date === value}>
                <button
                  type="button"
                  tabIndex={day.date === cursor ? 0 : -1}
                  aria-label={fullDate(day.date, locale)}
                  aria-current={day.date === today ? 'date' : undefined}
                  data-outside={!day.inMonth || undefined}
                  data-selected={day.date === value || undefined}
                  className={styles.day}
                  onClick={() => pick(day.date)}
                >
                  {day.day}
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className={styles.footer}>
        <Button variant="ghost" size="sm" disabled={value === null} onClick={() => pick(null)}>
          No due date
        </Button>
      </div>
    </div>
  );
}
