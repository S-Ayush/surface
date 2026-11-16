// One comment as a card (SPEC-013 §3.3, §7): avatar, author, "via API" or "via MCP", relative time
// (absolute on hover), "edited", the body, reaction chips and the actions. Presentational: it
// takes plain data, so a story renders it without a store. An `article` named "Comment by Ada,
// 3 hours ago", and the `comment` shortcut scope when focused (§7, SPEC-012 §3.6).
import type { DocNodeJSON } from '@surface/domain';
import {
  Avatar,
  IconButton,
  Menu,
  ReactionBar,
  type MenuEntry,
  type PickerEmoji,
  type ReactionChipData,
} from '@surface/ui';
import { MoreHorizontal, Reply } from 'lucide-react';
import type { ReactNode } from 'react';
import { agoText } from '../issues/issue-view.js';
import { CommentDoc } from './editor-host.js';
import { absoluteTime, agoLong, commentDomId } from './model.js';
import styles from './comments.module.css';

export interface CommentCardProps {
  readonly id: string;
  readonly authorName: string;
  /** `api` and `mcp` show as "via API" and "via MCP" (SPEC-013 D16). */
  readonly via: 'api' | 'mcp' | null;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly now: Date;
  /** The body; ignored for a deleted comment. */
  readonly body: DocNodeJSON;
  /** A placeholder: deleted, but its replies remain (§4.3). */
  readonly deleted?: boolean;
  /** Sent from this tab and not confirmed yet. */
  readonly pending?: boolean;
  /** A comment link scrolled here: highlighted for 2 s (§7). */
  readonly highlighted?: boolean;
  /** Replaces the body while the comment is edited. */
  readonly editor?: ReactNode;
  /** A refusal of the last save, shown with the editor (E3). */
  readonly error?: string | undefined;
  readonly chips: readonly ReactionChipData[];
  readonly onReact: (emoji: string, reacted: boolean) => void;
  readonly loadEmoji: () => Promise<readonly PickerEmoji[]>;
  readonly pickerOpen?: boolean;
  readonly onPickerOpenChange?: (open: boolean) => void;
  /** Archived and deleted issues hide every control that writes (D10). */
  readonly readOnly?: boolean;
  readonly onReply?: () => void;
  readonly menu?: readonly MenuEntry[];
  /** Set for the author only (§4.4, PLAN-013 S5): a checklist item toggles. */
  readonly onToggle?: (path: readonly number[], checked: boolean) => void;
  readonly children?: ReactNode;
}

export function CommentCard({
  id,
  authorName,
  via,
  createdAt,
  editedAt,
  now,
  body,
  deleted = false,
  pending = false,
  highlighted = false,
  editor,
  error,
  chips,
  onReact,
  loadEmoji,
  pickerOpen,
  onPickerOpenChange,
  readOnly = false,
  onReply,
  menu = [],
  onToggle,
  children,
}: CommentCardProps) {
  const label = `Comment by ${authorName}, ${agoLong(createdAt, now)}`;
  const showActions = !readOnly && !pending && editor === undefined;
  return (
    <article
      id={commentDomId(id)}
      className={styles.card}
      aria-label={label}
      tabIndex={0}
      data-shortcut-scope="comment"
      data-highlight={highlighted}
      data-pending={pending}
    >
      <div className={styles.header}>
        <Avatar name={authorName} size={20} />
        <span className={styles.author}>{authorName}</span>
        {via !== null && (
          <span className={styles.via}>{via === 'api' ? 'via API' : 'via MCP'}</span>
        )}
        <time className={styles.time} dateTime={createdAt} title={absoluteTime(createdAt)}>
          {agoText(createdAt, now)}
        </time>
        {editedAt !== null && !deleted && (
          <span className={styles.time} title={`Edited ${absoluteTime(editedAt)}`}>
            edited
          </span>
        )}
        {pending && <span className={styles.pendingMark}>Sending…</span>}
        <span className={styles.spacer} />
        {showActions && (
          <span className={styles.actions}>
            {onReply !== undefined && (
              <IconButton aria-label="Reply" icon={<Reply />} size="sm" onClick={onReply} />
            )}
            {menu.length > 0 && (
              <Menu
                align="end"
                trigger={
                  <IconButton aria-label="Comment options" icon={<MoreHorizontal />} size="sm" />
                }
                items={menu}
              />
            )}
          </span>
        )}
      </div>
      {deleted ? (
        <p className={styles.deleted}>This comment was deleted.</p>
      ) : editor !== undefined ? (
        <>
          {editor}
          {error !== undefined && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
        <CommentDoc doc={body} {...(onToggle === undefined ? {} : { onToggle })} />
      )}
      {!deleted && editor === undefined && (
        <div className={styles.reactions} data-empty={chips.length === 0}>
          <ReactionBar
            reactions={chips}
            onReact={onReact}
            loadEmoji={loadEmoji}
            readOnly={readOnly || pending}
            {...(pickerOpen === undefined ? {} : { pickerOpen })}
            {...(onPickerOpenChange === undefined ? {} : { onPickerOpenChange })}
          />
        </div>
      )}
      {children}
    </article>
  );
}
