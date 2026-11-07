// SPEC-005 AC-7 (shortcuts.md rule 5): the registry has no conflicts in overlapping scopes and no
// reserved browser shortcuts. Runs in `pnpm test`, so it fails CI.
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/commands/catalog.js';
import { toChord } from '../src/shortcuts/chord.js';
import {
  RESERVED_SHORTCUTS,
  findConflicts,
  findInvalid,
  findReserved,
  scopesOverlap,
} from '../src/shortcuts/conflicts.js';
import { SCOPES, SHORTCUTS, shortcut, type ShortcutDefinition } from '../src/shortcuts/registry.js';

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
    });
    expect(toChord('Esc').key).toBe('Escape');
    expect(toChord('?').key).toBe('?');
    expect(toChord('Mod++').key).toBe('+');
  });
  it('rejects what the matcher cannot honour', () => {
    expect(() => toChord('Shift+/')).toThrow(/Write the character/);
    expect(() => toChord('Alt+[')).toThrow(/Write the character instead of Alt\+\[/);
    expect(() => toChord('Hyper+K')).toThrow(/Unknown modifier/);
    expect(() => toChord('Mod+Mod+K')).toThrow(/Repeated/);
    expect(() => toChord('Mod+Banana')).toThrow(/Unknown key/);
    expect(() => toChord('Mod+Shift')).toThrow(/Unknown key/);
  });
});
