/**
 * Command-menu contexts an operation applies to (command-menu.md §3.3). `global` is the
 * "nothing selected" context. New contexts are added as features need them (additive only).
 */
export const UI_CONTEXTS = ['global', 'team', 'issue', 'issues', 'project'] as const;

export type UiContext = (typeof UI_CONTEXTS)[number];

/** Command-menu metadata for an operation (SPEC-003 §3.1, SPEC-005 §4.1). */
export interface OperationUi {
  /** Sentence case; ends with "…" when the command opens a picker or form ("Rename team…"). */
  readonly title: string;
  /** Icon name from the design system (`packages/ui`). Kept as a string so this package stays UI-free. */
  readonly icon: string;
  readonly contexts: readonly UiContext[];
  /** Key binding in the shortcut registry's notation (SPEC-005 §5), or `null` for none. */
  readonly shortcut?: string | null;
}
