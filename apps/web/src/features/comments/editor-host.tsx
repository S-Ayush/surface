// The editor and the document view, loaded on demand (SPEC-013 §7 "Performance"; PLAN-013 S5): the
// issue list's chunk holds neither TipTap nor the emoji data. A comment card renders `DocView`, the
// box and the edit mode render the editor. `loadEmojiLazy` is one module-level function, so the
// picker's loader doesn't change between renders.
import type { DocViewProps, RichTextEditorProps } from '@surface/editor';
import { lazy, Suspense, useEffect, useState } from 'react';
import styles from './comments.module.css';

const LazyEditor = lazy(() =>
  import('@surface/editor').then((module) => ({ default: module.RichTextEditor })),
);
const LazyDocView = lazy(() =>
  import('@surface/editor').then((module) => ({ default: module.DocView })),
);

export function CommentEditor(props: RichTextEditorProps) {
  return (
    <Suspense fallback={<div className={styles.editorLoading} aria-busy="true" />}>
      <LazyEditor {...props} />
    </Suspense>
  );
}

export function CommentDoc(props: DocViewProps) {
  return (
    <Suspense fallback={<div className={styles.editorLoading} aria-busy="true" />}>
      <LazyDocView {...props} />
    </Suspense>
  );
}

/** The emoji data for the picker (an `EmojiPicker`'s `loadEmoji`). */
export const loadEmojiLazy = () => import('@surface/editor').then((module) => module.loadEmoji());

/**
 * Emoji names for the chips' accessible names ("Thumbs up, 3 reactions"), once the data has
 * loaded. Loads it only when `wanted` (there is a chip), and never fails the page: without names
 * a chip is named by its emoji.
 */
export function useEmojiNames(wanted: boolean): ReadonlyMap<string, string> | undefined {
  const [names, setNames] = useState<ReadonlyMap<string, string> | undefined>(undefined);
  useEffect(() => {
    if (!wanted || names !== undefined) return;
    let current = true;
    loadEmojiLazy().then(
      (emoji) => {
        if (current) setNames(new Map(emoji.map((entry) => [entry.unicode, entry.label])));
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [wanted, names]);
  return names;
}
