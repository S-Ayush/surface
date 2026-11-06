import { Avatar as RadixAvatar } from 'radix-ui';
import { Children, createContext, use, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx } from '../../internal/cx.js';
import { LABEL_HUES, type LabelHue } from '../../tokens.gen.js';
import styles from './Avatar.module.css';

export type AvatarSize = 16 | 20 | 24 | 32;

const SIZE_CLASS: Record<AvatarSize, string | undefined> = {
  16: styles.xs,
  20: styles.sm,
  24: styles.md,
  32: styles.lg,
};

/** Stable palette hue for a name, so a person keeps one colour everywhere (design-system §5.1). */
export function avatarHue(name: string): LabelHue {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return LABEL_HUES[hash % LABEL_HUES.length] ?? 'gray';
}

/** "Ada Lovelace" → "AL"; "ada" → "A". Splits by code point, so an emoji never yields half a pair. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const firstChar = (word: string | undefined) =>
    word === undefined ? '' : (Array.from(word)[0] ?? '');
  const first = firstChar(words[0]);
  const last = words.length > 1 ? firstChar(words[words.length - 1]) : '';
  return (first + last).toUpperCase();
}

/** Set by AvatarGroup so its avatars and the "+N" chip share one size. */
const GroupSizeContext = createContext<AvatarSize | null>(null);

export type AvatarProps = Omit<ComponentPropsWithRef<'span'>, 'children'> & {
  /** The person's name: the accessible name and the source of initials and colour. */
  name: string;
  src?: string;
  /** Defaults to 24, or to the size of the enclosing AvatarGroup. */
  size?: AvatarSize;
  /** Shows an "online" presence dot. */
  online?: boolean;
};

export function Avatar({
  name,
  src,
  size: sizeProp,
  online = false,
  className,
  ...props
}: AvatarProps) {
  const groupSize = use(GroupSizeContext);
  const size = sizeProp ?? groupSize ?? 24;
  const hue = avatarHue(name);
  return (
    <span
      className={cx(styles.root, SIZE_CLASS[size], className)}
      role="img"
      aria-label={online ? `${name} (online)` : name}
      {...props}
    >
      <RadixAvatar.Root className={styles.avatar}>
        {src !== undefined && <RadixAvatar.Image className={styles.image} src={src} alt="" />}
        <RadixAvatar.Fallback
          className={styles.fallback}
          style={{ backgroundColor: `var(--label-${hue})` }}
          aria-hidden="true"
        >
          {initials(name)}
        </RadixAvatar.Fallback>
      </RadixAvatar.Root>
      {online && <span className={styles.presence} aria-hidden="true" />}
    </span>
  );
}

export type AvatarGroupProps = Omit<ComponentPropsWithRef<'span'>, 'children'> & {
  children: ReactNode;
  /** Avatars shown before collapsing the rest into "+N". */
  max?: number;
  size?: AvatarSize;
};

/** Overlapping avatars with a "+N" overflow. */
export function AvatarGroup({
  children,
  max = 3,
  size = 24,
  className,
  ...props
}: AvatarGroupProps) {
  const items = Children.toArray(children);
  const hidden = items.length - max;
  return (
    <span className={cx(styles.group, SIZE_CLASS[size], className)} role="group" {...props}>
      <GroupSizeContext value={size}>{items.slice(0, max)}</GroupSizeContext>
      {hidden > 0 && (
        <span className={cx(styles.root, styles.overflow)} role="img" aria-label={`${hidden} more`}>
          <span aria-hidden="true">+{hidden}</span>
        </span>
      )}
    </span>
  );
}
