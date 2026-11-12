// SPEC-005 AC-7 (shortcuts.md rule 5): the registry has no conflicts in overlapping scopes and no
// reserved browser shortcuts. Runs in `pnpm test`, so it fails CI.
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/commands/catalog.js';
import { chordText, toChord } from '../src/shortcuts/chord.js';
import {
  LATER_RESERVED,
  RESERVED_SHORTCUTS,
  findConflicts,
  findInvalid,
  findReserved,
  scopesOverlap,
} from '../src/shortcuts/conflicts.js';
import {
  SCOPES,
  SHORTCUTS,
  TEXT_EDITING_CHORDS,
  shortcut,
  type ShortcutDefinition,
} from '../src/shortcuts/registry.js';

const binding = (
  overrides: Partial<ShortcutDefinition> & Pick<ShortcutDefinition, 'id' | 'keys'>,
) =>
  shortcut({
    scope: 'global',
    command: 'help:shortcuts',
    group: 'Test',
    milestone: 'M0',
    ...overrides,
  });

describe('the registry', () => {
  it('has no conflicting bindings in overlapping scopes', () => {
    expect(findConflicts(SHORTCUTS)).toEqual([]);
  });
  it('uses no reserved browser or OS shortcut', () => {
    expect(findReserved(SHORTCUTS)).toEqual([]);
  });
  it('has unique ids and valid overrides', () => {
    expect(findInvalid(SHORTCUTS)).toEqual([]);
  });
  it('binds every shortcut to a known command in a known scope', () => {
    for (const entry of SHORTCUTS) {
      expect(Object.keys(COMMANDS)).toContain(entry.command);
      expect(SCOPES).toContain(entry.scope);
    }
  });
  it('has the M0 bindings of SPEC-005 §5', () => {
    const m0 = SHORTCUTS.filter((entry) => entry.milestone === 'M0' && entry.scope === 'global');
    expect(m0.map((entry) => entry.keys.join(' '))).toEqual(
      expect.arrayContaining(['Mod+K', '?', '[', 'Mod+,', 'Alt+Shift+T', 'Esc', 'G S', 'O T']),
    );
  });
});

describe('findConflicts', () => {
  it('flags the same keys in the same scope', () => {
    const conflicts = findConflicts([
      binding({ id: 'a', keys: 'X' }),
      binding({ id: 'b', keys: 'X' }),
    ]);
    expect(conflicts).toEqual([expect.objectContaining({ a: 'a', b: 'b' })]);
  });
  it('flags a single key that begins a sequence', () => {
    const conflicts = findConflicts([
      binding({ id: 'g', keys: 'G' }),
      binding({ id: 'gs', keys: ['G', 'S'] }),
    ]);
    expect(conflicts).toHaveLength(1);
  });
  it('flags global against any scope, and overlapping component scopes', () => {
    expect(
      findConflicts([
        binding({ id: 'a', keys: 'P' }),
        binding({ id: 'b', keys: 'P', scope: 'issue' }),
      ]),
    ).toHaveLength(1);
    expect(
      findConflicts([
        binding({ id: 'a', keys: 'J', scope: 'list' }),
        binding({ id: 'b', keys: 'J', scope: 'issue' }),
      ]),
    ).toHaveLength(1);
  });
  it('allows the same keys in scopes that are never active together', () => {
    expect(
      findConflicts([
        binding({ id: 'a', keys: 'H', scope: 'inbox' }),
        binding({ id: 'b', keys: 'H', scope: 'triage' }),
      ]),
    ).toEqual([]);
    expect(scopesOverlap('inbox', 'triage')).toBe(false);
    expect(scopesOverlap('modal', 'list')).toBe(false);
  });
  it('treats a page scope as active together with any focused component scope', () => {
    for (const page of ['inbox', 'triage'] as const) {
      for (const component of ['list', 'issue', 'editor'] as const) {
        expect(scopesOverlap(page, component)).toBe(true);
      }
    }
  });
  it('flags Mod+K against Ctrl+K, which are the same keys on Windows and Linux', () => {
    expect(
      findConflicts([binding({ id: 'a', keys: 'Mod+K' }), binding({ id: 'b', keys: 'Ctrl+K' })]),
    ).toHaveLength(1);
  });
  it('allows a deliberate override only when it is declared (E1: the editor’s Mod+K)', () => {
    const global = binding({ id: 'global.k', keys: 'Mod+K' });
    const editor = binding({ id: 'editor.link', keys: 'Mod+K', scope: 'editor' });
    expect(findConflicts([global, editor])).toHaveLength(1);
    expect(findConflicts([global, { ...editor, shadows: ['global.k'] }])).toEqual([]);
  });
});

describe('findReserved', () => {
  it.each(RESERVED_SHORTCUTS)('rejects %s', (keys) => {
    expect(findReserved([binding({ id: 'x', keys })])).toHaveLength(1);
  });
  it('rejects Ctrl+W (Mod+W on Windows) and a reserved chord inside a sequence', () => {
    expect(findReserved([binding({ id: 'x', keys: 'Ctrl+W' })])).toHaveLength(1);
    expect(findReserved([binding({ id: 'y', keys: ['G', 'Mod+T'] })])).toHaveLength(1);
  });
  it('accepts the M0 keys', () => {
    expect(findReserved([binding({ id: 'x', keys: 'Mod+K' })])).toEqual([]);
  });
});

describe('findInvalid', () => {
  it('flags duplicate ids and overrides of unknown or same-scope bindings', () => {
    const a = binding({ id: 'a', keys: 'X' });
    expect(findInvalid([a, binding({ id: 'a', keys: 'Y' })])).toEqual(['Duplicate shortcut id a']);
    expect(findInvalid([binding({ id: 'b', keys: 'X', shadows: ['nope'] })])).toEqual([
      'b shadows unknown nope',
    ]);
    expect(findInvalid([a, binding({ id: 'c', keys: 'Y', shadows: ['a'] })])).toEqual([
      'c can only shadow a less specific scope than global',
    ]);
  });
  it('flags an override that points at a more specific scope (a global binding over the editor)', () => {
    const editor = binding({ id: 'editor.k', keys: 'Mod+K', scope: 'editor' });
    const global = binding({ id: 'global.k', keys: 'Mod+K', shadows: ['editor.k'] });
    expect(findInvalid([editor, global])).toEqual([
      'global.k can only shadow a less specific scope than editor',
    ]);
    const page = binding({ id: 'triage.x', keys: 'X', scope: 'triage', shadows: ['editor.k'] });
    expect(findInvalid([editor, page])).toHaveLength(1);
  });
});

describe('chord notation', () => {
  it('parses modifiers, letters, characters and named keys', () => {
    expect(toChord('Mod+Shift+k')).toEqual({
      mod: true,
      ctrl: false,
      alt: false,
      shift: true,
      key: 'K',
      code: 'KeyK',
    });
    expect(toChord('Esc').key).toBe('Escape');
    expect(toChord('?').key).toBe('?');
    expect(toChord('Mod++').key).toBe('+');
  });
  it('rejects what the matcher cannot honour', () => {
    expect(() => toChord('Shift+é')).toThrow(/No physical key/);
    expect(() => toChord('Alt+é')).toThrow(/No physical key/);
    expect(() => toChord('Hyper+K')).toThrow(/Unknown modifier/);
    expect(() => toChord('Mod+Mod+K')).toThrow(/Repeated/);
    expect(() => toChord('Mod+Banana')).toThrow(/Unknown key/);
    expect(() => toChord('Mod+Shift')).toThrow(/Unknown key/);
  });
});

describe('SPEC-012 §3.6: the M1 key map', () => {
  const pressedKeys = (entry: (typeof SHORTCUTS)[number]) => entry.keys.join(' ');
  const find = (id: string) => SHORTCUTS.find((entry) => entry.id === id);

  it('has every key of the table, in the scope the table gives', () => {
    const expected: [string, string, string][] = [
      ['C', 'global', 'issue:create'],
      ['G E', 'global', 'nav:team-issues'],
      ['G M', 'global', 'nav:my-issues'],
      ['G D', 'global', 'nav:drafts'],
      ['G X', 'global', 'nav:team-archive'],
      ['Ctrl+Shift+1', 'global', 'nav:team-1'],
      ['Ctrl+Shift+9', 'global', 'nav:team-9'],
      ['Mod+Z', 'global', 'issue:restore-last-deleted'],
      ['J', 'list', 'list:next'],
      ['ArrowDown', 'list', 'list:next'],
      ['K', 'list', 'list:previous'],
      ['ArrowUp', 'list', 'list:previous'],
      ['Enter', 'list', 'list:open'],
      ['T', 'list', 'list:toggle-group'],
      ['Alt+T', 'list', 'list:toggle-all-groups'],
      ['S', 'issue', 'issue:status'],
      ['P', 'issue', 'issue:priority'],
      ['A', 'issue', 'issue:assignee'],
      ['L', 'issue', 'issue:labels'],
      ['Shift+E', 'issue', 'issue:estimate'],
      ['Shift+D', 'issue', 'issue:due-date'],
      ['Mod+Shift+D', 'issue', 'issue:remove-due-date'],
      ['I', 'issue', 'issue:assign-to-me'],
      ['Shift+R', 'issue', 'issue:rename'],
      ['Mod+.', 'issue', 'issue:copy-id'],
      ['Mod+Shift+,', 'issue', 'issue:copy-url'],
      ['Mod+Shift+.', 'issue', 'issue:copy-branch'],
      ["Mod+Shift+'", 'issue', 'issue:copy-title'],
      ['Mod+Alt+C', 'issue', 'issue:copy-markdown'],
      ['Mod+Backspace', 'issue', 'issue:delete'],
      ['#', 'issue', 'issue:restore'],
      ['J', 'issue-page', 'issue-page:next'],
      ['K', 'issue-page', 'issue-page:previous'],
      ['Mod+Enter', 'issue-page', 'issue-page:save-description'],
      ['Ctrl+M', 'issue-page', 'issue-page:comment'],
      ['Ctrl+Shift+I', 'issue-page', 'issue-page:focus-description'],
      ['Mod+Shift+U', 'issue-page', 'issue-page:attach-file'],
      ['Ctrl+L', 'issue-page', 'issue-page:link-url'],
      ['R', 'comment', 'comment:reply'],
      ['Enter', 'comment', 'comment:send'],
      ['Mod+Enter', 'comment', 'comment:send'],
      ['Mod+B', 'editor', 'editor:bold'],
      ['Mod+K', 'editor', 'editor:link'],
      ['Mod+Alt+0', 'editor', 'editor:paragraph'],
      ['Mod+Shift+7', 'editor', 'editor:checklist'],
      ['Mod+Shift+\\', 'editor', 'editor:code-block'],
      ['Alt+Shift+.', 'editor', 'editor:blockquote'],
      ['Mod+Enter', 'editor', 'editor:toggle-checklist-item'],
      ['Mod+Z', 'editor', 'editor:undo'],
      ['Mod+Shift+Z', 'editor', 'editor:redo'],
      ['Enter', 'settings-row', 'settings-row:edit'],
      ['E', 'settings-row', 'settings-row:edit-name'],
      ['Alt+ArrowUp', 'settings-row', 'settings-row:move-up'],
      ['Alt+ArrowDown', 'settings-row', 'settings-row:move-down'],
      ['Mod+Backspace', 'settings-row', 'settings-row:delete'],
      ['Mod+/', 'global', 'help:shortcuts'],
    ];
    for (const [keys, scope, command] of expected) {
      expect(
        SHORTCUTS.some(
          (entry) =>
            pressedKeys(entry) === keys && entry.scope === scope && entry.command === command,
        ),
        `${keys} in ${scope} runs ${command}`,
      ).toBe(true);
    }
  });

  it('binds the macOS-only keys only on macOS, and every other key everywhere', () => {
    const macOnly = SHORTCUTS.filter((entry) => entry.platform === 'mac').map((entry) => entry.id);
    expect(macOnly.sort()).toEqual([
      'issuePage.comment',
      'issuePage.focusDescription',
      'issuePage.linkUrl',
    ]);
  });

  it('refuses a text-editing chord without whileTyping: false (AC-9)', () => {
    for (const keys of [
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
    ]) {
      expect(() => binding({ id: 'x', keys }), keys).toThrow(/whileTyping: false/);
      expect(() => binding({ id: 'x', keys, whileTyping: false }), keys).not.toThrow();
    }
    expect(() => binding({ id: 'x', keys: ['G', 'Mod+Z'] })).toThrow(/whileTyping: false/);
  });

  it('sets whileTyping: false on every registered text-editing chord', () => {
    for (const entry of SHORTCUTS) {
      if (entry.chords.some((chord) => TEXT_EDITING_CHORDS.includes(chordText(chord)))) {
        expect(entry.whileTyping, entry.id).toBe(false);
      }
    }
  });

  it('keeps the keys reserved for later commands unbound', () => {
    const bound = new Set(
      SHORTCUTS.map((entry) => entry.keys.map((key) => chordText(toChord(key))).join(' ')),
    );
    for (const keys of LATER_RESERVED) {
      expect(bound.has(keys.map((key) => chordText(toChord(key))).join(' ')), keys.join(' ')).toBe(
        false,
      );
    }
  });

  it('puts Ctrl+L, which is the address bar on Windows and Linux, on macOS only', () => {
    expect(find('issuePage.linkUrl')?.platform).toBe('mac');
    expect(findReserved(SHORTCUTS)).toEqual([]);
  });

  it('knows the new scopes and their overlaps', () => {
    expect(SCOPES).toEqual(expect.arrayContaining(['issue-page', 'comment', 'settings-row']));
    for (const [a, b] of [
      ['issue-page', 'issue'],
      ['issue-page', 'editor'],
      ['issue-page', 'comment'],
      ['comment', 'issue'],
      ['comment', 'editor'],
    ] as const) {
      expect(scopesOverlap(a, b), `${a} with ${b}`).toBe(true);
    }
    expect(scopesOverlap('settings-row', 'list')).toBe(false);
  });

  it('flags a clash between the new scopes unless the more specific one shadows', () => {
    const page = binding({ id: 'p', keys: 'Mod+Enter', scope: 'issue-page' });
    const comment = binding({ id: 'c', keys: 'Mod+Enter', scope: 'comment' });
    expect(findConflicts([page, comment])).toHaveLength(1);
    expect(findConflicts([page, { ...comment, shadows: ['p'] }])).toEqual([]);
  });
});
