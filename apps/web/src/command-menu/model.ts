// The command model (SPEC-005 §4.1). Every entry in the command menu is a Command, whatever its
// source: registry operations, navigation, or the app's own commands (toggles, help).
import type { Actor } from '@surface/domain';
import type { UiContext } from '@surface/operations';
import type { SyncStore } from '@surface/sync-client';
import type { ReactNode } from 'react';

/** Sections, in display order (command-menu.md §1). Search sections arrive in M2. */
export const SECTIONS = ['suggested', 'navigation', 'create', 'settings', 'help'] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_LABELS: Readonly<Record<Section, string>> = {
  suggested: 'Suggested',
  navigation: 'Navigation',
  create: 'Create',
  settings: 'Settings',
  help: 'Help',
};

/**
 * What commands act on (SPEC-005 §4.1 `focused` and `selection`, merged): the focused or
 * selected entities and the label of the context chip ("ENG", "3 selected issues").
 */
export type CommandTarget =
  | { readonly kind: 'global' }
  | {
      readonly kind: Exclude<UiContext, 'global'>;
      readonly ids: readonly string[];
      readonly label: string;
    };

export const GLOBAL_TARGET: CommandTarget = { kind: 'global' };

/** A team as the command menu shows it (navigation, "Open team…"). */
export type TeamSummary = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
};

/** SPEC-005 §4.1 `CommandContext`, maintained by the shell (§6). */
export type CommandContext = {
  readonly route: string;
  readonly target: CommandTarget;
  /** The signed-in user; `null` before sign-in (operation commands are then hidden). */
  readonly actor: Actor | null;
  readonly store: SyncStore | null;
  /** Client-side navigation; navigation commands are hidden without it. */
  readonly navigate?: (path: string) => void;
  /** Live teams the user can see, in sidebar order. */
  readonly teams: () => readonly TeamSummary[];
};

/** A nested page (command-menu.md §3.2): a filtered list of choices, e.g. the team colours. */
export type CommandPage = {
  /** Breadcrumb text: "Change team color". */
  readonly title: string;
  readonly placeholder?: string;
  readonly items: () => readonly PageItem[];
  /** Shown when there is nothing to choose: "No teams yet". */
  readonly empty?: string;
  /**
   * The context chip for this page, replacing the target's label: "ENG-142 · Fix login redirect"
   * (command-menu.md §3.5), so it is clear which issue a key press changes.
   */
  readonly chip?: string;
  /**
   * A page that is a component, not a filtered list: the Property picker, the same one the
   * anchored popover shows (§3.5). It owns the search field, the options and their keys; the menu
   * only supplies the frame, the chip, the breadcrumb and the footer.
   */
  readonly body?: (host: PageHost) => ReactNode;
  /** The number-key range of a `body` page, for the footer hint: ["1", "9"], priority ["0", "4"]. */
  readonly quickKeys?: readonly [string, string];
};

/** What a `body` page asks of the menu around it. */
export type PageHost = {
  /** Closes the whole menu (a pick, `Enter`, `Esc`). Focus goes back to where it came from. */
  readonly close: () => void;
  /** Goes back a page (`Backspace` on an empty query). */
  readonly back: () => void;
  /** Reports the page's search text, so the footer hides the number-key hint once it is set. */
  readonly query: (text: string) => void;
};

export type PageItem = {
  readonly id: string;
  readonly title: string;
  readonly keywords?: readonly string[];
  /** A palette hue for a colour dot (`--label-<hue>`), for colour pages. */
  readonly hue?: string;
  run(): void | Promise<void>;
};

export type Command = {
  /** "op:team.create" | "nav:my-issues" | "toggle:theme" */
  readonly id: string;
  readonly title: string;
  /** The section it belongs to when it does not apply to the context (Suggested is computed). */
  readonly section: Exclude<Section, 'suggested'>;
  readonly keywords?: readonly string[];
  /** Shortcuts in the registry notation, shown as hints: "Mod+K", ["G", "S"]. */
  readonly shortcuts?: readonly (string | readonly string[])[];
  /** Whether the command is offered now (context and permission). Re-evaluated reactively (E4). */
  readonly when?: (ctx: CommandContext) => boolean;
  /** Whether it acts on the current target, for Suggested and the ×2 ranking boost (§4.2). */
  readonly appliesTo?: (ctx: CommandContext) => boolean;
  /**
   * `false`: with an empty query the command stays in its own section even where it applies to the
   * context. For team administration, which Linear leaves to typing (SPEC-005 §4.2, changed
   * 2026-11-26). With a query it ranks as usual, including the ×2 boost.
   */
  readonly suggest?: false;
  /**
   * A command that destroys data (Delete issue). It never ranks first for a keyword-only match
   * (SPEC-012 §3.8, AC-16): only when its title matches the query better than any other command.
   */
  readonly destructive?: boolean;
  readonly run?: (ctx: CommandContext) => void | Promise<void>;
  readonly page?: (ctx: CommandContext) => CommandPage;
};

/** A source turns the context into commands; the menu merges every source. */
export type CommandSource = (ctx: CommandContext) => readonly Command[];
