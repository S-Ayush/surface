import { SmilePlus } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { cx } from '../../internal/cx.js';
import { EmojiPicker, type PickerEmoji } from '../EmojiPicker/EmojiPicker.js';
import { IconButton } from '../IconButton/IconButton.js';
import { Popover, PopoverContent, PopoverTrigger } from '../Popover/Popover.js';
import { Tooltip } from '../Tooltip/Tooltip.js';
import styles from './ReactionChips.module.css';

/** One chip: an emoji on a comment or an issue (SPEC-013 §3.4, `{ emoji, count, mine }` of §6.1). */
export interface ReactionChipData {
  readonly emoji: string;
  readonly count: number;
  /** The viewer is among those who set it: the chip is pressed. */
  readonly mine: boolean;
  /** The emoji's name, like "thumbs up"; the emoji itself when the data isn't loaded yet. */
  readonly label?: string;
  /** Who reacted, for the tooltip, the viewer as "You" first; empty for no tooltip. */
  readonly people?: readonly string[];
}

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Thumbs up, 3 reactions, including you" (SPEC-013 §3.4): the chip's accessible name. */
export function reactionChipLabel(
  chip: Pick<ReactionChipData, 'emoji' | 'count' | 'mine' | 'label'>,
) {
  const name = sentenceCase(chip.label ?? chip.emoji);
  const count = `${String(chip.count)} ${chip.count === 1 ? 'reaction' : 'reactions'}`;
  return chip.mine ? `${name}, ${count}, including you` : `${name}, ${count}`;
}

/** "You, Ada and Iris reacted with thumbs up": the chip's tooltip, naming who reacted. */
export function reactionTooltip(chip: Pick<ReactionChipData, 'emoji' | 'label' | 'people'>) {
  const people = chip.people ?? [];
  if (people.length === 0) return undefined;
  const names =
    people.length === 1
      ? (people[0] ?? '')
      : `${people.slice(0, -1).join(', ')} and ${people[people.length - 1] ?? ''}`;
  return `${names} reacted with ${chip.label ?? chip.emoji}`;
}

export type ReactionChipsProps = {
  reactions: readonly ReactionChipData[];
  /** Sets (`true`) or clears (`false`) the viewer's reaction: `reaction.set`. */
  onReact: (emoji: string, reacted: boolean) => void;
  /**
   * Archived or deleted issues are read-only (SPEC-013 D10): the chips show but don't toggle. They
   * stay focusable (`aria-disabled`, not `disabled`), so the keyboard still reaches the tooltip
   * naming who reacted.
   */
  readOnly?: boolean;
  className?: string;
};

/**
 * The reactions on a comment or an issue (SPEC-013 §3.4): one chip per emoji with its count,
 * pressed (`aria-pressed`) when it includes the viewer. Clicking toggles the viewer's reaction.
 */
export function ReactionChips({
  reactions,
  onReact,
  readOnly = false,
  className,
}: ReactionChipsProps) {
  if (reactions.length === 0) return null;
  return (
    <ul className={cx(styles.chips, className)} aria-label="Reactions">
      {reactions.map((chip) => {
        const button = (
          <button
            type="button"
            className={styles.chip}
            aria-pressed={chip.mine}
            aria-label={reactionChipLabel(chip)}
            aria-disabled={readOnly ? true : undefined}
            onClick={readOnly ? undefined : () => onReact(chip.emoji, !chip.mine)}
          >
            <span aria-hidden="true" className={styles.emoji}>
              {chip.emoji}
            </span>
            <span aria-hidden="true" className={styles.count}>
              {chip.count}
            </span>
          </button>
        );
        const tooltip = reactionTooltip(chip);
        return (
          <li key={chip.emoji} className={styles.item}>
            {tooltip === undefined ? button : <Tooltip content={tooltip}>{button}</Tooltip>}
          </li>
        );
      })}
    </ul>
  );
}

export type ReactionBarProps = ReactionChipsProps & {
  /** The emoji data for the picker: `apps/web` passes the editor's lazy `loadEmoji` (AC-16). */
  loadEmoji: () => Promise<readonly PickerEmoji[]>;
  /** The picker's open state, when the host opens it too (the "Add reaction…" command). */
  pickerOpen?: boolean;
  onPickerOpenChange?: (open: boolean) => void;
};

/**
 * The chips and an **Add reaction** button that opens the EmojiPicker (SPEC-013 §3.4, §7): under a
 * comment, and under the issue's description. Read-only rows have no button (D10).
 */
export function ReactionBar({
  loadEmoji,
  pickerOpen,
  onPickerOpenChange,
  className,
  ...chips
}: ReactionBarProps): ReactElement {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = pickerOpen ?? ownOpen;
  const setOpen = (next: boolean) => {
    if (pickerOpen === undefined) setOwnOpen(next);
    onPickerOpenChange?.(next);
  };
  return (
    <div className={cx(styles.row, className)}>
      <ReactionChips {...chips} />
      {chips.readOnly !== true && (
        <Popover open={open} onOpenChange={setOpen}>
          <Tooltip content="Add reaction">
            <PopoverTrigger>
              <IconButton aria-label="Add reaction" icon={<SmilePlus />} size="sm" />
            </PopoverTrigger>
          </Tooltip>
          <PopoverContent aria-label="Add reaction">
            <EmojiPicker
              label="Add reaction"
              loadEmoji={loadEmoji}
              // Choosing an emoji sets it (§3.4); one already set stays set.
              onSelect={(emoji) => chips.onReact(emoji, true)}
              onClose={() => setOpen(false)}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
