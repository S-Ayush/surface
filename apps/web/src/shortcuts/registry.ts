// The shortcut registry (shortcuts.md §1, SPEC-005 §5). Every shortcut is declared once, here.
// The engine, the `?` help overlay and the conflict test all read SHORTCUTS.
import type { CommandId } from '../commands/catalog.js';
import type { Platform } from '@surface/ui';
import { chordText, toChord, type Chord } from './chord.js';
import { BUILD_MILESTONE, isInBuild, type Milestone } from './milestone.js';

/** Where a binding is active (shortcuts.md §2). Overlay scopes come from the overlay manager. */
export const SCOPES = [
  'global',
  'list',
  'issue',
  'inbox',
  'triage',
  'editor',
  'issue-page',
  'comment',
  'settings-row',
  'modal',
  'picker',
] as const;
export type Scope = (typeof SCOPES)[number];

export type ShortcutDefinition = {
  id: string;
  /** One chord ("Mod+K", "?") or a sequence (["G", "S"]). */
  keys: string | readonly string[];
  scope: Scope;
  command: CommandId;
  /** Heading in the `?` help overlay. */
  group: string;
  milestone: Milestone;
  /** Ids of bindings in a less specific scope that this one deliberately overrides (E1). */
  shadows?: readonly string[];
  /** Nothing to say when the command is unavailable (Esc is pressed all the time). */
  quiet?: boolean;
  /**
   * A component handles the key itself (F8: the Radix toast region). The binding is listed in help
   * and checked for conflicts, but the engine does not dispatch it.
   */
  native?: boolean;
  /**
   * Whether the binding fires while focus is in a text field or the editor (SPEC-012 §4.2).
   * Default: `Mod` and `Ctrl` chords and Esc do, plain keys don't. `false` makes even a `Mod`
   * chord skip text fields. Text-editing chords must say `false` (TEXT_EDITING_CHORDS).
   */
  whileTyping?: boolean;
  /** Only on this platform: the registry drops the binding elsewhere and help hides it. */
  platform?: 'mac';
};

/**
 * Chords that edit text in a field. A binding on one must set `whileTyping: false`, or ⌘⌫ in a
 * title would delete the issue (SPEC-005 §5, SPEC-012 E16).
 */
export const TEXT_EDITING_CHORDS: readonly string[] = [
  'Mod+Backspace',
  'Mod+Delete',
  'Mod+Z',
  'Mod+Shift+Z',
  'Mod+A',
  'Mod+C',
  'Mod+X',
  'Mod+V',
  'Mod+ArrowLeft',
  'Mod+ArrowRight',
  'Mod+ArrowUp',
  'Mod+ArrowDown',
];

export type Shortcut = Omit<ShortcutDefinition, 'keys'> & {
  readonly keys: readonly string[];
  readonly chords: readonly Chord[];
};

export function shortcut(definition: ShortcutDefinition): Shortcut {
  const keys = typeof definition.keys === 'string' ? [definition.keys] : [...definition.keys];
  if (keys.length === 0) throw new Error(`Shortcut ${definition.id} has no keys`);
  const chords = keys.map(toChord);
  if (definition.whileTyping !== false) {
    const editing = chords.find((chord) => TEXT_EDITING_CHORDS.includes(chordText(chord)));
    if (editing !== undefined) {
      throw new Error(
        `Shortcut ${definition.id}: ${chordText(editing)} edits text, so it needs whileTyping: false`,
      );
    }
  }
  return { ...definition, keys, chords };
}

/** The bindings that exist on a platform: a `platform: 'mac'` binding is dropped elsewhere. */
export function forPlatform(bindings: readonly Shortcut[], platform: Platform): Shortcut[] {
  return bindings.filter(
    (binding) => binding.platform === undefined || binding.platform === platform,
  );
}

export const SHORTCUTS: readonly Shortcut[] = [
  // shortcuts.md §3.1
  shortcut({
    id: 'global.commandMenu',
    keys: 'Mod+K',
    scope: 'global',
    command: 'ui:command-menu',
    group: 'General',
    milestone: 'M0',
  }),
  shortcut({
    id: 'global.help',
    keys: '?',
    scope: 'global',
    command: 'help:shortcuts',
    group: 'General',
    milestone: 'M0',
  }),
  shortcut({
    id: 'global.sidebar',
    keys: '[',
    scope: 'global',
    command: 'toggle:sidebar',
    group: 'General',
    milestone: 'M0',
  }),
  shortcut({
    id: 'global.settings',
    keys: 'Mod+,',
    scope: 'global',
    command: 'nav:settings',
    group: 'General',
    milestone: 'M0',
  }),
  shortcut({
    id: 'global.theme',
    keys: 'Alt+Shift+T',
    scope: 'global',
    command: 'toggle:theme',
    group: 'General',
    milestone: 'M0',
  }),
  shortcut({
    id: 'global.escape',
    keys: 'Esc',
    scope: 'global',
    command: 'ui:escape',
    group: 'General',
    milestone: 'M0',
    quiet: true,
  }),
  shortcut({
    id: 'global.notifications',
    keys: 'F8',
    scope: 'global',
    command: 'ui:focus-notifications',
    group: 'General',
    milestone: 'M0',
    native: true,
  }),
  // shortcuts.md §3.2
  shortcut({
    id: 'nav.settings',
    keys: ['G', 'S'],
    scope: 'global',
    command: 'nav:settings',
    group: 'Navigation',
    milestone: 'M0',
  }),
  shortcut({
    id: 'nav.openTeam',
    keys: ['O', 'T'],
    scope: 'global',
    command: 'nav:open-team',
    group: 'Navigation',
    milestone: 'M0',
  }),
  // shortcuts.md §3.8 (the other picker and dialog keys are handled by the components)
  shortcut({
    id: 'dialog.submit',
    keys: 'Mod+Enter',
    scope: 'modal',
    command: 'ui:submit-dialog',
    group: 'Dialogs and pickers',
    milestone: 'M0',
    shadows: ['editor.toggleChecklistItem'],
  }),
  // SPEC-012 §3.6: the M1 key map (Linear's keys). Handlers arrive with the screens (PLAN-012 S3 to S6).
  shortcut({
    id: 'global.helpSlash',
    keys: 'Mod+/',
    scope: 'global',
    command: 'help:shortcuts',
    group: 'General',
    milestone: 'M0',
  }),
  shortcut({
    id: 'issue.create',
    keys: 'C',
    scope: 'global',
    command: 'issue:create',
    group: 'Issues',
    milestone: 'M1',
  }),
  shortcut({
    id: 'nav.teamIssues',
    keys: ['G', 'E'],
    scope: 'global',
    command: 'nav:team-issues',
    group: 'Navigation',
    milestone: 'M1',
  }),
  shortcut({
    id: 'nav.myIssues',
    keys: ['G', 'M'],
    scope: 'global',
    command: 'nav:my-issues',
    group: 'Navigation',
    milestone: 'M1',
  }),
  shortcut({
    id: 'nav.drafts',
    keys: ['G', 'D'],
    scope: 'global',
    command: 'nav:drafts',
    group: 'Navigation',
    milestone: 'M1',
  }),
  shortcut({
    id: 'nav.teamArchive',
    keys: ['G', 'X'],
    scope: 'global',
    command: 'nav:team-archive',
    group: 'Navigation',
    milestone: 'M1',
  }),
  shortcut({
    id: 'nav.team1',
    keys: 'Ctrl+Shift+1',
    scope: 'global',
    command: 'nav:team-1',
    group: 'Navigation',
    milestone: 'M1',
  }),
  shortcut({
    id: 'nav.team2',
    keys: 'Ctrl+Shift+2',
    scope: 'global',
    command: 'nav:team-2',
    group: 'Navigation',
    milestone: 'M1',
  }),
  shortcut({
    id: 'nav.team3',
    keys: 'Ctrl+Shift+3',
    scope: 'global',
    command: 'nav:team-3',
    group: 'Navigation',
    milestone: 'M1',
  }),
  shortcut({
    id: 'nav.team4',
    keys: 'Ctrl+Shift+4',
    scope: 'global',
    command: 'nav:team-4',
    group: 'Navigation',
    milestone: 'M1',
  }),
  shortcut({
    id: 'nav.team5',
    keys: 'Ctrl+Shift+5',
    scope: 'global',
    command: 'nav:team-5',
    group: 'Navigation',
    milestone: 'M1',
  }),
  shortcut({
    id: 'nav.team6',
    keys: 'Ctrl+Shift+6',
    scope: 'global',
    command: 'nav:team-6',
    group: 'Navigation',
    milestone: 'M1',
  }),
  shortcut({
    id: 'nav.team7',
    keys: 'Ctrl+Shift+7',
    scope: 'global',
    command: 'nav:team-7',
    group: 'Navigation',
    milestone: 'M1',
  }),
  shortcut({
    id: 'nav.team8',
    keys: 'Ctrl+Shift+8',
    scope: 'global',
    command: 'nav:team-8',
    group: 'Navigation',
    milestone: 'M1',
  }),
  shortcut({
    id: 'nav.team9',
    keys: 'Ctrl+Shift+9',
    scope: 'global',
    command: 'nav:team-9',
    group: 'Navigation',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issue.restoreLastDeleted',
    keys: 'Mod+Z',
    scope: 'global',
    command: 'issue:restore-last-deleted',
    group: 'Issues',
    milestone: 'M1',
    whileTyping: false,
  }),
  shortcut({
    id: 'list.nextJ',
    keys: 'J',
    scope: 'list',
    command: 'list:next',
    group: 'Issue list',
    milestone: 'M1',
  }),
  shortcut({
    id: 'list.nextArrow',
    keys: 'ArrowDown',
    scope: 'list',
    command: 'list:next',
    group: 'Issue list',
    milestone: 'M1',
  }),
  shortcut({
    id: 'list.previousK',
    keys: 'K',
    scope: 'list',
    command: 'list:previous',
    group: 'Issue list',
    milestone: 'M1',
  }),
  shortcut({
    id: 'list.previousArrow',
    keys: 'ArrowUp',
    scope: 'list',
    command: 'list:previous',
    group: 'Issue list',
    milestone: 'M1',
  }),
  shortcut({
    id: 'list.open',
    keys: 'Enter',
    scope: 'list',
    command: 'list:open',
    group: 'Issue list',
    milestone: 'M1',
  }),
  shortcut({
    id: 'list.toggleGroup',
    keys: 'T',
    scope: 'list',
    command: 'list:toggle-group',
    group: 'Issue list',
    milestone: 'M1',
  }),
  shortcut({
    id: 'list.toggleAllGroups',
    keys: 'Alt+T',
    scope: 'list',
    command: 'list:toggle-all-groups',
    group: 'Issue list',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issue.status',
    keys: 'S',
    scope: 'issue',
    command: 'issue:status',
    group: 'Issue',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issue.priority',
    keys: 'P',
    scope: 'issue',
    command: 'issue:priority',
    group: 'Issue',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issue.assignee',
    keys: 'A',
    scope: 'issue',
    command: 'issue:assignee',
    group: 'Issue',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issue.labels',
    keys: 'L',
    scope: 'issue',
    command: 'issue:labels',
    group: 'Issue',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issue.estimate',
    keys: 'Shift+E',
    scope: 'issue',
    command: 'issue:estimate',
    group: 'Issue',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issue.dueDate',
    keys: 'Shift+D',
    scope: 'issue',
    command: 'issue:due-date',
    group: 'Issue',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issue.removeDueDate',
    keys: 'Mod+Shift+D',
    scope: 'issue',
    command: 'issue:remove-due-date',
    group: 'Issue',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issue.assignToMe',
    keys: 'I',
    scope: 'issue',
    command: 'issue:assign-to-me',
    group: 'Issue',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issue.rename',
    keys: 'Shift+R',
    scope: 'issue',
    command: 'issue:rename',
    group: 'Issue',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issue.copyId',
    keys: 'Mod+.',
    scope: 'issue',
    command: 'issue:copy-id',
    group: 'Issue',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issue.copyUrl',
    keys: 'Mod+Shift+,',
    scope: 'issue',
    command: 'issue:copy-url',
    group: 'Issue',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issue.copyBranch',
    keys: 'Mod+Shift+.',
    scope: 'issue',
    command: 'issue:copy-branch',
    group: 'Issue',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issue.copyTitle',
    keys: "Mod+Shift+'",
    scope: 'issue',
    command: 'issue:copy-title',
    group: 'Issue',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issue.copyMarkdown',
    keys: 'Mod+Alt+C',
    scope: 'issue',
    command: 'issue:copy-markdown',
    group: 'Issue',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issue.delete',
    keys: 'Mod+Backspace',
    scope: 'issue',
    command: 'issue:delete',
    group: 'Issue',
    milestone: 'M1',
    whileTyping: false,
  }),
  shortcut({
    id: 'issue.restore',
    keys: '#',
    scope: 'issue',
    command: 'issue:restore',
    group: 'Issue',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issuePage.next',
    keys: 'J',
    scope: 'issue-page',
    command: 'issue-page:next',
    group: 'Issue page',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issuePage.previous',
    keys: 'K',
    scope: 'issue-page',
    command: 'issue-page:previous',
    group: 'Issue page',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issuePage.saveDescription',
    keys: 'Mod+Enter',
    scope: 'issue-page',
    command: 'issue-page:save-description',
    group: 'Issue page',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issuePage.comment',
    keys: 'Ctrl+M',
    scope: 'issue-page',
    command: 'issue-page:comment',
    group: 'Issue page',
    milestone: 'M1',
    platform: 'mac',
  }),
  shortcut({
    id: 'issuePage.focusDescription',
    keys: 'Ctrl+Shift+I',
    scope: 'issue-page',
    command: 'issue-page:focus-description',
    group: 'Issue page',
    milestone: 'M1',
    platform: 'mac',
  }),
  shortcut({
    id: 'issuePage.attachFile',
    keys: 'Mod+Shift+U',
    scope: 'issue-page',
    command: 'issue-page:attach-file',
    group: 'Issue page',
    milestone: 'M1',
  }),
  shortcut({
    id: 'issuePage.linkUrl',
    keys: 'Ctrl+L',
    scope: 'issue-page',
    command: 'issue-page:link-url',
    group: 'Issue page',
    milestone: 'M1',
    platform: 'mac',
  }),
  shortcut({
    id: 'comment.reply',
    keys: 'R',
    scope: 'comment',
    command: 'comment:reply',
    group: 'Comments',
    milestone: 'M1',
  }),
  shortcut({
    id: 'comment.sendEnter',
    keys: 'Enter',
    scope: 'comment',
    command: 'comment:send',
    group: 'Comments',
    milestone: 'M1',
    whileTyping: true,
  }),
  shortcut({
    id: 'comment.sendMod',
    keys: 'Mod+Enter',
    scope: 'comment',
    command: 'comment:send',
    group: 'Comments',
    milestone: 'M1',
    shadows: ['issuePage.saveDescription'],
  }),
  shortcut({
    id: 'editor.bold',
    keys: 'Mod+B',
    scope: 'editor',
    command: 'editor:bold',
    group: 'Editor',
    milestone: 'M1',
    native: true,
  }),
  shortcut({
    id: 'editor.italic',
    keys: 'Mod+I',
    scope: 'editor',
    command: 'editor:italic',
    group: 'Editor',
    milestone: 'M1',
    native: true,
  }),
  shortcut({
    id: 'editor.underline',
    keys: 'Mod+U',
    scope: 'editor',
    command: 'editor:underline',
    group: 'Editor',
    milestone: 'M1',
    native: true,
  }),
  shortcut({
    id: 'editor.code',
    keys: 'Mod+E',
    scope: 'editor',
    command: 'editor:code',
    group: 'Editor',
    milestone: 'M1',
    native: true,
  }),
  shortcut({
    id: 'editor.strikethrough',
    keys: 'Mod+Shift+X',
    scope: 'editor',
    command: 'editor:strikethrough',
    group: 'Editor',
    milestone: 'M1',
    native: true,
  }),
  shortcut({
    id: 'editor.link',
    keys: 'Mod+K',
    scope: 'editor',
    command: 'editor:link',
    group: 'Editor',
    milestone: 'M1',
    shadows: ['global.commandMenu'],
  }),
  shortcut({
    id: 'editor.blockquote',
    keys: 'Alt+Shift+.',
    scope: 'editor',
    command: 'editor:blockquote',
    group: 'Editor',
    milestone: 'M1',
    native: true,
    whileTyping: true,
  }),
  shortcut({
    id: 'editor.paragraph',
    keys: 'Mod+Alt+0',
    scope: 'editor',
    command: 'editor:paragraph',
    group: 'Editor',
    milestone: 'M1',
    native: true,
  }),
  shortcut({
    id: 'editor.heading1',
    keys: 'Mod+Alt+1',
    scope: 'editor',
    command: 'editor:heading-1',
    group: 'Editor',
    milestone: 'M1',
    native: true,
  }),
  shortcut({
    id: 'editor.heading2',
    keys: 'Mod+Alt+2',
    scope: 'editor',
    command: 'editor:heading-2',
    group: 'Editor',
    milestone: 'M1',
    native: true,
  }),
  shortcut({
    id: 'editor.heading3',
    keys: 'Mod+Alt+3',
    scope: 'editor',
    command: 'editor:heading-3',
    group: 'Editor',
    milestone: 'M1',
    native: true,
  }),
  shortcut({
    id: 'editor.heading4',
    keys: 'Mod+Alt+4',
    scope: 'editor',
    command: 'editor:heading-4',
    group: 'Editor',
    milestone: 'M1',
    native: true,
  }),
  shortcut({
    id: 'editor.checklist',
    keys: 'Mod+Shift+7',
    scope: 'editor',
    command: 'editor:checklist',
    group: 'Editor',
    milestone: 'M1',
    native: true,
    shadows: ['nav.team7'],
  }),
  shortcut({
    id: 'editor.bulletedList',
    keys: 'Mod+Shift+8',
    scope: 'editor',
    command: 'editor:bulleted-list',
    group: 'Editor',
    milestone: 'M1',
    native: true,
    shadows: ['nav.team8'],
  }),
  shortcut({
    id: 'editor.numberedList',
    keys: 'Mod+Shift+9',
    scope: 'editor',
    command: 'editor:numbered-list',
    group: 'Editor',
    milestone: 'M1',
    native: true,
    shadows: ['nav.team9'],
  }),
  shortcut({
    id: 'editor.toggleChecklistItem',
    keys: 'Mod+Enter',
    scope: 'editor',
    command: 'editor:toggle-checklist-item',
    group: 'Editor',
    milestone: 'M1',
    shadows: ['issuePage.saveDescription', 'comment.sendMod'],
  }),
  shortcut({
    id: 'editor.codeBlock',
    keys: 'Mod+Shift+\\',
    scope: 'editor',
    command: 'editor:code-block',
    group: 'Editor',
    milestone: 'M1',
    native: true,
  }),
  shortcut({
    id: 'editor.moveUp',
    keys: 'Alt+ArrowUp',
    scope: 'editor',
    command: 'editor:move-block-up',
    group: 'Editor',
    milestone: 'M1',
    native: true,
    whileTyping: true,
  }),
  shortcut({
    id: 'editor.moveDown',
    keys: 'Alt+ArrowDown',
    scope: 'editor',
    command: 'editor:move-block-down',
    group: 'Editor',
    milestone: 'M1',
    native: true,
    whileTyping: true,
  }),
  shortcut({
    id: 'editor.undo',
    keys: 'Mod+Z',
    scope: 'editor',
    command: 'editor:undo',
    group: 'Editor',
    milestone: 'M1',
    native: true,
    whileTyping: false,
    shadows: ['issue.restoreLastDeleted'],
  }),
  shortcut({
    id: 'editor.redo',
    keys: 'Mod+Shift+Z',
    scope: 'editor',
    command: 'editor:redo',
    group: 'Editor',
    milestone: 'M1',
    native: true,
    whileTyping: false,
  }),
  shortcut({
    id: 'settingsRow.edit',
    keys: 'Enter',
    scope: 'settings-row',
    command: 'settings-row:edit',
    group: 'Settings lists',
    milestone: 'M1',
  }),
  shortcut({
    id: 'settingsRow.editName',
    keys: 'E',
    scope: 'settings-row',
    command: 'settings-row:edit-name',
    group: 'Settings lists',
    milestone: 'M1',
  }),
  shortcut({
    id: 'settingsRow.moveUp',
    keys: 'Alt+ArrowUp',
    scope: 'settings-row',
    command: 'settings-row:move-up',
    group: 'Settings lists',
    milestone: 'M1',
  }),
  shortcut({
    id: 'settingsRow.moveDown',
    keys: 'Alt+ArrowDown',
    scope: 'settings-row',
    command: 'settings-row:move-down',
    group: 'Settings lists',
    milestone: 'M1',
  }),
  shortcut({
    id: 'settingsRow.delete',
    keys: 'Mod+Backspace',
    scope: 'settings-row',
    command: 'settings-row:delete',
    group: 'Settings lists',
    milestone: 'M1',
    whileTyping: false,
  }),
];

/** The bindings this build ships (SPEC-005 §5): the engine sees only these, like the help overlay. */
export function inBuild(
  bindings: readonly Shortcut[],
  milestone: Milestone = BUILD_MILESTONE,
): Shortcut[] {
  return bindings.filter((binding) => isInBuild(binding.milestone, milestone));
}
