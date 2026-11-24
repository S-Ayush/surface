/**
 * Command-menu contexts an operation applies to (command-menu.md §3.3). `global` is the
 * "nothing selected" context. New contexts are added as features need them (additive only).
 */
export const UI_CONTEXTS = [
  'global',
  'team',
  'issue',
  'issues',
  'project',
  'comment',
  'attachment',
] as const;

export type UiContext = (typeof UI_CONTEXTS)[number];

/** What a command acts on, as `ui.available` sees it (the command menu's target, SPEC-005 §6). */
export interface UiTarget {
  readonly kind: UiContext;
  readonly ids: readonly string[];
}

/** Command-menu metadata for an operation (SPEC-003 §3.1, SPEC-005 §4.1). */
export interface OperationUi {
  /** Sentence case; ends with "…" when the command opens a picker or form ("Rename team…"). */
  readonly title: string;
  /** Icon name from the design system (`packages/ui`). Kept as a string so this package stays UI-free. */
  readonly icon: string;
  readonly contexts: readonly UiContext[];
  /** Key binding in the shortcut registry's notation (SPEC-005 §5), or `null` for none. */
  readonly shortcut?: string | null;
  /**
   * The command applies only when this returns true for the command target and the client store
   * (SPEC-003 §3.1, added 2026-11-12): no edit command on an archived or deleted issue, and
   * "Restore issue" only on one. `store` is the client's `SyncStore`; this package cannot import
   * it, so the predicate narrows it. Absent means always available. A throwing predicate hides
   * the command.
   */
  readonly available?: (target: UiTarget, store: unknown) => boolean;
}
