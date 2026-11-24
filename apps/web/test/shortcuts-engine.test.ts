// SPEC-005 §5 shortcut engine: AC-5 (typing suppression), AC-6 (sequences), E2 (IME), E3 (layouts),
// scope resolution and the "not available here" rule.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyInput } from '../src/shortcuts/chord.js';
import { SEQUENCE_TIMEOUT_MS } from '../src/shortcuts/engine.js';
import { SHORTCUTS, inBuild, shortcut } from '../src/shortcuts/registry.js';
import { body, element, keys, setup } from './shortcut-fakes.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AC-5: plain keys never fire while typing; Mod+K and Esc do', () => {
  const field = element('input', { type: 'text' });
  const typingTargets = {
    'text input': field,
    'search input': element('input', { type: 'search' }),
    'input with no type': element('input'),
    textarea: element('textarea'),
    select: element('select'),
    contenteditable: element('div', { contentEditable: true }),
    'inside a contenteditable': element('span', {
      parent: element('div', { contentEditable: true }),
    }),
    'inside [data-shortcuts=off]': element('button', {
      parent: element('div', { attrs: { 'data-shortcuts': 'off' } }),
    }),
  };

  for (const [name, target] of Object.entries(typingTargets)) {
    it(`ignores ?, [ and G in a ${name}`, () => {
      const { commands, press, hints } = setup();
      const run = vi.fn();
      commands.register('help:shortcuts', { run });
      commands.register('toggle:sidebar', { run });
      for (const key of [keys.questionMark, keys.bracket, keys.letter('G')]) {
        expect(press(key, target)).toEqual({ taken: false, prevented: false });
      }
      expect(run).not.toHaveBeenCalled();
      expect(hints.sequence).not.toHaveBeenCalled();
    });
  }

  it('runs Mod+K and Esc in a text input', () => {
    const { commands, press } = setup();
    const open = vi.fn();
    const escape = vi.fn();
    commands.register('ui:command-menu', { run: open });
    commands.register('ui:escape', { run: escape });
    expect(press(keys.modK('mac'), field)).toEqual({ taken: true, prevented: true });
    press(keys.escape, field);
    expect(open).toHaveBeenCalledOnce();
    expect(escape).toHaveBeenCalledOnce();
  });

  it('still fires on a focused checkbox or button, which take no text', () => {
    const { commands, press } = setup();
    const run = vi.fn();
    commands.register('help:shortcuts', { run });
    press(keys.questionMark, element('input', { type: 'checkbox' }));
    press(keys.questionMark, element('button'));
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('AC-6: sequences', () => {
  it('G then S within 1 s goes to settings, with a hint in between', () => {
    // The M0 key map: from M1 on, G also continues to E, M, D and X.
    const { commands, press, hints, engine } = setup({ bindings: inBuild(SHORTCUTS, 'M0') });
    const settings = vi.fn();
    commands.register('nav:settings', { run: settings });

    expect(press(keys.letter('G'))).toEqual({ taken: true, prevented: true });
    expect(engine.pendingSequence).toEqual(['G']);
    expect(hints.sequence).toHaveBeenCalledOnce();
    const [prefix, next] = hints.sequence.mock.calls[0] ?? [];
    expect(prefix).toEqual(['G']);
    expect(next?.map((binding) => binding.id)).toEqual(['nav.settings']);

    vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS - 1);
    expect(press(keys.letter('S'))).toEqual({ taken: true, prevented: true });
    expect(settings).toHaveBeenCalledOnce();
    expect(hints.clear).toHaveBeenCalled();
    expect(engine.pendingSequence).toBeNull();
  });

  it('at the default build G then S still goes to settings, and the hint lists E, M, D, X and S', () => {
    const { commands, press, hints } = setup();
    const settings = vi.fn();
    commands.register('nav:settings', { run: settings });

    press(keys.letter('G'));
    const [, next] = hints.sequence.mock.calls[0] ?? [];
    const ids = next?.map((binding) => binding.id) ?? [];
    for (const id of [
      'nav.teamIssues',
      'nav.myIssues',
      'nav.drafts',
      'nav.teamArchive',
      'nav.settings',
    ]) {
      expect(ids).toContain(id);
    }
    expect(press(keys.letter('S'))).toEqual({ taken: true, prevented: true });
    expect(settings).toHaveBeenCalledOnce();
  });

  it('G alone shows the hint, then times out harmlessly', () => {
    const { commands, press, hints, engine } = setup();
    const settings = vi.fn();
    commands.register('nav:settings', { run: settings });

    press(keys.letter('G'));
    vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS);
    expect(engine.pendingSequence).toBeNull();
    expect(hints.clear).toHaveBeenCalledOnce();
    // S on its own is not a shortcut.
    expect(press(keys.letter('S'))).toEqual({ taken: false, prevented: false });
    expect(settings).not.toHaveBeenCalled();
    expect(hints.unavailable).not.toHaveBeenCalled();
  });

  it('a key that does not continue the sequence ends it and is read on its own', () => {
    const { commands, press, engine } = setup();
    const help = vi.fn();
    commands.register('help:shortcuts', { run: help });
    press(keys.letter('G'));
    press(keys.questionMark);
    expect(help).toHaveBeenCalledOnce();
    expect(engine.pendingSequence).toBeNull();
  });

  it('a modifier pressed alone does not break the sequence', () => {
    const { commands, press } = setup();
    const settings = vi.fn();
    commands.register('nav:settings', { run: settings });
    press(keys.letter('G'));
    press({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    press(keys.letter('S'));
    expect(settings).toHaveBeenCalledOnce();
  });

  it('O then T opens a team, and its command being unavailable shows the hint', () => {
    const { press, hints } = setup();
    press(keys.letter('O'));
    expect(press(keys.letter('T'))).toEqual({ taken: true, prevented: true });
    expect(hints.unavailable).toHaveBeenCalledWith(expect.objectContaining({ id: 'nav.openTeam' }));
  });

  it('the second key obeys typing suppression: G, then S typed into a field, is text', () => {
    const { commands, press, engine } = setup();
    const settings = vi.fn();
    commands.register('nav:settings', { run: settings });
    press(keys.letter('G'));
    expect(press(keys.letter('S'), element('input', { type: 'text' }))).toEqual({
      taken: false,
      prevented: false,
    });
    expect(settings).not.toHaveBeenCalled();
    expect(engine.pendingSequence).toBeNull();
  });

  it('the second key obeys overlay capture: G, then a menu opens, then S does nothing', () => {
    const { commands, press, state } = setup();
    const settings = vi.fn();
    commands.register('nav:settings', { run: settings });
    press(keys.letter('G'));
    state.layer = 'menu';
    expect(press(keys.letter('S')).taken).toBe(false);
    expect(settings).not.toHaveBeenCalled();
  });

  it('Esc during a sequence cancels it', () => {
    const { commands, press, engine } = setup();
    const settings = vi.fn();
    commands.register('nav:settings', { run: settings });
    press(keys.letter('G'));
    press(keys.escape);
    expect(engine.pendingSequence).toBeNull();
    press(keys.letter('S'));
    expect(settings).not.toHaveBeenCalled();
  });
});

describe('E2: keys that compose text are never shortcuts', () => {
  it('ignores keydown while an IME composition is active', () => {
    const { commands, press } = setup();
    const help = vi.fn();
    commands.register('help:shortcuts', { run: help });
    expect(press({ ...keys.questionMark, isComposing: true }).taken).toBe(false);
    expect(press({ key: 'Process', code: 'KeyG', keyCode: 229 }).taken).toBe(false);
    expect(help).not.toHaveBeenCalled();
  });
});

describe('E3: keyboard layouts', () => {
  type Case = [layout: string, event: Partial<KeyInput> & { key: string }];
  const runs = (
    command: Parameters<ReturnType<typeof setup>['commands']['register']>[0],
    platform: 'mac' | 'other',
    events: readonly (Partial<KeyInput> & { key: string })[],
  ) => {
    const { commands, press } = setup({ platform });
    const run = vi.fn();
    commands.register(command, { run });
    for (const event of events) press(event);
    return run.mock.calls.length;
  };

  const questionMarks: Case[] = [
    ['US', { key: '?', code: 'Slash', shiftKey: true }],
    ['AZERTY (Shift+,)', { key: '?', code: 'KeyM', shiftKey: true }],
    ['QWERTZ (Shift+ß)', { key: '?', code: 'Minus', shiftKey: true }],
  ];
  it.each(questionMarks)('? matches the typed character on %s', (_layout, event) => {
    expect(runs('help:shortcuts', 'other', [event])).toBe(1);
  });

  const brackets: Case[] = [
    ['US', { key: '[', code: 'BracketLeft' }],
    ['AZERTY, Windows AltGr+5', { key: '[', code: 'Digit5', ctrlKey: true, altKey: true }],
    ['QWERTZ, Windows AltGr+8', { key: '[', code: 'Digit8', ctrlKey: true, altKey: true }],
  ];
  it.each(brackets)('[ matches the typed character on %s', (_layout, event) => {
    expect(runs('toggle:sidebar', 'other', [event])).toBe(1);
  });
  it('[ typed with Option on a Mac AZERTY or QWERTZ layout matches', () => {
    const events = [
      { key: '[', code: 'Digit5', altKey: true, shiftKey: true },
      { key: '[', code: 'Digit5', altKey: true },
    ];
    expect(runs('toggle:sidebar', 'mac', events)).toBe(2);
  });
  it('Ctrl+[ is not [', () => {
    expect(
      runs('toggle:sidebar', 'other', [{ key: '[', code: 'BracketLeft', ctrlKey: true }]),
    ).toBe(0);
  });

  it('Mod+K matches the K key position on US, AZERTY, QWERTZ and Russian layouts', () => {
    const mac = ['k', 'k', 'k', 'л'].map((key) => ({ key, code: 'KeyK', metaKey: true }));
    const other = ['k', 'k', 'k', 'л'].map((key) => ({ key, code: 'KeyK', ctrlKey: true }));
    expect(runs('ui:command-menu', 'mac', mac)).toBe(4);
    expect(runs('ui:command-menu', 'other', other)).toBe(4);
  });
  it('Mod+K needs exactly Mod: not Ctrl on a Mac, not Mod+Shift, not Meta elsewhere', () => {
    expect(runs('ui:command-menu', 'mac', [{ key: 'k', code: 'KeyK', ctrlKey: true }])).toBe(0);
    expect(
      runs('ui:command-menu', 'mac', [{ key: 'K', code: 'KeyK', metaKey: true, shiftKey: true }]),
    ).toBe(0);
    expect(runs('ui:command-menu', 'other', [{ key: 'k', code: 'KeyK', metaKey: true }])).toBe(0);
  });

  it('Alt+Shift+T matches by position, so Option on a Mac (which types ˇ) works', () => {
    expect(
      runs('toggle:theme', 'mac', [{ key: 'ˇ', code: 'KeyT', altKey: true, shiftKey: true }]),
    ).toBe(1);
    expect(
      runs('toggle:theme', 'other', [{ key: 'T', code: 'KeyT', altKey: true, shiftKey: true }]),
    ).toBe(1);
  });

  it('Alt+letter matches by position when Option types a symbol (Option+R is ®)', () => {
    const custom = [
      shortcut({
        id: 'test.altR',
        keys: 'Alt+R',
        scope: 'global',
        command: 'help:shortcuts',
        group: 'Test',
        milestone: 'M0',
      }),
    ];
    const { commands, press } = setup({ bindings: custom });
    const run = vi.fn();
    commands.register('help:shortcuts', { run });
    press({ key: '®', code: 'KeyR', altKey: true });
    expect(run).toHaveBeenCalledOnce();
  });

  const commas: Case[] = [
    ['US', { key: ',', code: 'Comma', metaKey: true }],
    ['AZERTY (the , key is KeyM)', { key: ',', code: 'KeyM', metaKey: true }],
    ['QWERTZ', { key: ',', code: 'Comma', metaKey: true }],
  ];
  it.each(commas)('Mod+, matches the typed comma on %s', (_layout, event) => {
    expect(runs('nav:settings', 'mac', [event])).toBe(1);
  });

  it('Mod+, does not fire with Option or AltGr added (another chord)', () => {
    expect(
      runs('nav:settings', 'mac', [{ key: ',', code: 'Comma', metaKey: true, altKey: true }]),
    ).toBe(0);
    expect(
      runs('nav:settings', 'other', [{ key: ',', code: 'Comma', ctrlKey: true, altKey: true }]),
    ).toBe(0);
  });

  it('G then S matches on AZERTY, QWERTZ and Russian layouts', () => {
    const sequences = [
      [keys.letter('G'), keys.letter('S')],
      [
        { key: 'п', code: 'KeyG' },
        { key: 'ы', code: 'KeyS' },
      ],
    ];
    expect(runs('nav:settings', 'other', sequences.flat())).toBe(2);
  });
  it('Caps Lock does not stop single letters, but Shift+G is not G', () => {
    expect(runs('nav:settings', 'other', [{ key: 'G', code: 'KeyG' }, keys.letter('S')])).toBe(1);
    expect(
      runs('nav:settings', 'other', [{ key: 'G', code: 'KeyG', shiftKey: true }, keys.letter('S')]),
    ).toBe(0);
  });
  it('a symbol on a letter position is not that letter (AZERTY , is KeyM)', () => {
    const custom = [
      shortcut({
        id: 'test.m',
        keys: 'M',
        scope: 'global',
        command: 'help:shortcuts',
        group: 'Test',
        milestone: 'M0',
      }),
    ];
    const { commands, press } = setup({ bindings: custom });
    const run = vi.fn();
    commands.register('help:shortcuts', { run });
    press({ key: ',', code: 'KeyM' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('scopes', () => {
  const custom = [
    shortcut({
      id: 'test.global',
      keys: 'X',
      scope: 'global',
      command: 'help:shortcuts',
      group: 'Test',
      milestone: 'M0',
    }),
    shortcut({
      id: 'test.list',
      keys: 'X',
      scope: 'list',
      command: 'toggle:sidebar',
      group: 'Test',
      milestone: 'M0',
      shadows: ['test.global'],
    }),
    shortcut({
      id: 'test.inbox',
      keys: 'X',
      scope: 'inbox',
      command: 'toggle:theme',
      group: 'Test',
      milestone: 'M0',
      shadows: ['test.global'],
    }),
  ];
  const handlers = (commands: ReturnType<typeof setup>['commands']) => {
    const global = vi.fn();
    const list = vi.fn();
    const inbox = vi.fn();
    commands.register('help:shortcuts', { run: global });
    commands.register('toggle:sidebar', { run: list });
    commands.register('toggle:theme', { run: inbox });
    return { global, list, inbox };
  };

  it('a focused component scope wins over the page scope, which wins over global', () => {
    const { commands, press } = setup({ bindings: custom, pageScopes: ['inbox'] });
    const ran = handlers(commands);
    const row = element('div', {
      parent: element('div', { attrs: { 'data-shortcut-scope': 'list' } }),
    });
    press(keys.letter('X'), row);
    press(keys.letter('X'), body);
    expect(ran.list).toHaveBeenCalledOnce();
    expect(ran.inbox).toHaveBeenCalledOnce();
    expect(ran.global).not.toHaveBeenCalled();
  });

  it('falls back to global outside any scope', () => {
    const { commands, press } = setup({ bindings: custom });
    const ran = handlers(commands);
    press(keys.letter('X'));
    expect(ran.global).toHaveBeenCalledOnce();
  });

  it('an open overlay captures plain keys: global ? and page scopes do not fire', () => {
    for (const layer of ['modal', 'popover', 'menu'] as const) {
      const { commands, press } = setup({ layer, pageScopes: ['inbox'], bindings: custom });
      const ran = handlers(commands);
      expect(press(keys.letter('X')).taken).toBe(false);
      expect(ran.global).not.toHaveBeenCalled();
      expect(ran.inbox).not.toHaveBeenCalled();
    }
  });

  it('Mod chords still work over an overlay', () => {
    const { commands, press } = setup({ layer: 'menu' });
    const open = vi.fn();
    commands.register('ui:command-menu', { run: open });
    press(keys.modK('mac'));
    expect(open).toHaveBeenCalledOnce();
  });

  it('Mod+Enter submits only in the modal scope', () => {
    const submit = vi.fn();
    const withModal = setup({ layer: 'modal' });
    withModal.commands.register('ui:submit-dialog', { run: submit });
    withModal.press({ key: 'Enter', code: 'Enter', metaKey: true }, element('textarea'));
    expect(submit).toHaveBeenCalledOnce();

    const withoutModal = setup();
    withoutModal.commands.register('ui:submit-dialog', { run: submit });
    expect(withoutModal.press({ key: 'Enter', code: 'Enter', metaKey: true }).taken).toBe(false);
    expect(submit).toHaveBeenCalledOnce();
  });
});

describe('Esc and unavailable commands', () => {
  it('leaves an Esc that closed an overlay alone (S3: isOverlayEscape)', () => {
    const { commands, press } = setup({ overlayEscape: true });
    const escape = vi.fn();
    commands.register('ui:escape', { run: escape });
    expect(press(keys.escape)).toEqual({ taken: false, prevented: false });
    expect(escape).not.toHaveBeenCalled();
  });

  it('runs page-level Esc otherwise, and says nothing when there is nothing to do', () => {
    const { commands, press, hints } = setup();
    expect(press(keys.escape)).toEqual({ taken: false, prevented: false });
    expect(hints.unavailable).not.toHaveBeenCalled();
    const escape = vi.fn();
    commands.register('ui:escape', { run: escape });
    press(keys.escape);
    expect(escape).toHaveBeenCalledOnce();
  });

  it('a command without a handler, or whose `when` is false, is a no-op with a hint', () => {
    const { commands, press, hints } = setup();
    expect(press(keys.modK('mac'))).toEqual({ taken: true, prevented: true });
    expect(hints.unavailable).toHaveBeenCalledTimes(1);

    const run = vi.fn();
    commands.register('ui:command-menu', { run, when: () => false });
    press(keys.modK('mac'));
    expect(run).not.toHaveBeenCalled();
    expect(hints.unavailable).toHaveBeenCalledTimes(2);
  });

  it('leaves native bindings (F8) to their component', () => {
    const { commands, press } = setup();
    const run = vi.fn();
    commands.register('ui:focus-notifications', { run });
    expect(press({ key: 'F8', code: 'F8' })).toEqual({ taken: false, prevented: false });
    expect(run).not.toHaveBeenCalled();
  });

  it('ignores keys a component already handled, and held-down repeats', () => {
    const { commands, engine } = setup();
    const run = vi.fn();
    commands.register('help:shortcuts', { run });
    engine.handleKeydown({
      ...keys.questionMark,
      code: 'Slash',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      target: body,
      defaultPrevented: true,
      preventDefault: () => undefined,
    });
    engine.handleKeydown({
      key: '?',
      code: 'Slash',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
      repeat: true,
      target: body,
      defaultPrevented: false,
      preventDefault: () => undefined,
    });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('SPEC-012 §4.2: whileTyping, Ctrl, platform and fall-through', () => {
  const field = element('input', { type: 'text' });
  const area = element('textarea');
  const editable = element('div', { contentEditable: true });
  const binding = (
    overrides: Partial<Parameters<typeof shortcut>[0]> & { id: string; keys: string },
  ) =>
    shortcut({
      scope: 'global',
      command: 'help:shortcuts',
      group: 'Test',
      milestone: 'M0',
      ...overrides,
    });

  it.each([
    ['input', field],
    ['textarea', area],
    ['contenteditable', editable],
  ])(
    'a whileTyping: false Mod chord does not fire in a %s, and fires elsewhere (E16)',
    (_, target) => {
      const { commands, press } = setup({
        bindings: [binding({ id: 'x.delete', keys: 'Mod+Backspace', whileTyping: false })],
      });
      const run = vi.fn();
      commands.register('help:shortcuts', { run });
      const chord = { key: 'Backspace', code: 'Backspace', metaKey: true };
      expect(press(chord, target)).toEqual({ taken: false, prevented: false });
      expect(run).not.toHaveBeenCalled();
      expect(press(chord).taken).toBe(true);
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it('a Mod chord without whileTyping still fires while typing (the default, as before)', () => {
    const { commands, press } = setup({ bindings: [binding({ id: 'x.k', keys: 'Mod+J' })] });
    const run = vi.fn();
    commands.register('help:shortcuts', { run });
    press({ key: 'j', code: 'KeyJ', metaKey: true }, field);
    expect(run).toHaveBeenCalledOnce();
  });

  it('whileTyping: true lets a plain key fire in a field; an Alt chord does not by default (E14)', () => {
    const { commands, press } = setup({
      bindings: [
        binding({ id: 'x.enter', keys: 'Enter', whileTyping: true }),
        binding({ id: 'x.alt', keys: 'Alt+T', command: 'toggle:sidebar' }),
      ],
    });
    const enter = vi.fn();
    const alt = vi.fn();
    commands.register('help:shortcuts', { run: enter });
    commands.register('toggle:sidebar', { run: alt });
    press({ key: 'Enter', code: 'Enter' }, area);
    press({ key: '†', code: 'KeyT', altKey: true }, area);
    expect(enter).toHaveBeenCalledOnce();
    expect(alt).not.toHaveBeenCalled();
    press({ key: '†', code: 'KeyT', altKey: true });
    expect(alt).toHaveBeenCalledOnce();
  });

  it('a platform: mac binding does not exist on other platforms', () => {
    const bindings = [binding({ id: 'x.mac', keys: 'Ctrl+M', platform: 'mac' })];
    const mac = setup({ platform: 'mac', bindings });
    const other = setup({ platform: 'other', bindings });
    const run = vi.fn();
    mac.commands.register('help:shortcuts', { run });
    other.commands.register('help:shortcuts', { run });
    const chord = { key: 'm', code: 'KeyM', ctrlKey: true };
    expect(other.press(chord)).toEqual({ taken: false, prevented: false });
    expect(run).not.toHaveBeenCalled();
    expect(mac.press(chord).taken).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('Ctrl+Shift+1 is the Control key on macOS and Cmd+Shift+1 does not fire it', () => {
    const { commands, press } = setup({
      bindings: [binding({ id: 'x.team1', keys: 'Ctrl+Shift+1' })],
    });
    const run = vi.fn();
    commands.register('help:shortcuts', { run });
    press({ key: '!', code: 'Digit1', metaKey: true, shiftKey: true });
    expect(run).not.toHaveBeenCalled();
    press({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true });
    expect(run).toHaveBeenCalledOnce();
  });

  it('falls through to a less specific binding whose command is available (editor Mod+Enter)', () => {
    const issuePage = binding({
      id: 'x.save',
      keys: 'Mod+Enter',
      scope: 'issue-page',
      command: 'issue-page:save-description',
    });
    const editor = binding({
      id: 'x.toggle',
      keys: 'Mod+Enter',
      scope: 'editor',
      command: 'editor:toggle-checklist-item',
      shadows: ['x.save'],
    });
    const { commands, press, hints } = setup({
      bindings: [issuePage, editor],
      pageScopes: ['issue-page'],
    });
    const save = vi.fn();
    const toggle = vi.fn();
    commands.register('issue-page:save-description', { run: save });
    let inChecklist = false;
    commands.register('editor:toggle-checklist-item', { run: toggle, when: () => inChecklist });
    const target = element('div', {
      attrs: { 'data-shortcut-scope': 'editor' },
      contentEditable: true,
    });
    const chord = { key: 'Enter', code: 'Enter', metaKey: true };
    press(chord, target);
    expect(save).toHaveBeenCalledOnce();
    inChecklist = true;
    press(chord, target);
    expect(toggle).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(hints.unavailable).not.toHaveBeenCalled();
  });

  it('says why a command is unavailable when its handler gives a reason (SPEC-005 §5)', () => {
    const { commands, press, hints } = setup({
      bindings: [binding({ id: 'x.status', keys: 'S', scope: 'issue', command: 'issue:status' })],
    });
    commands.register('issue:status', {
      run: () => undefined,
      when: () => false,
      reason: () => 'ENG-42 is archived. Restore it to edit it.',
    });
    const target = element('div', { attrs: { 'data-shortcut-scope': 'issue' } });
    expect(press(keys.letter('S'), target)).toEqual({ taken: true, prevented: true });
    expect(hints.unavailable).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'x.status' }),
      'ENG-42 is archived. Restore it to edit it.',
    );
  });

  it('the new scopes activate from a focused element or the page scope stack', () => {
    const { commands, press } = setup({
      bindings: [
        binding({ id: 'x.reply', keys: 'R', scope: 'comment', command: 'comment:reply' }),
        binding({
          id: 'x.row',
          keys: 'E',
          scope: 'settings-row',
          command: 'settings-row:edit-name',
        }),
        binding({ id: 'x.next', keys: 'J', scope: 'issue-page', command: 'issue-page:next' }),
      ],
      pageScopes: ['issue-page'],
    });
    const reply = vi.fn();
    const edit = vi.fn();
    const next = vi.fn();
    commands.register('comment:reply', { run: reply });
    commands.register('settings-row:edit-name', { run: edit });
    commands.register('issue-page:next', { run: next });
    press(keys.letter('R'), element('div', { attrs: { 'data-shortcut-scope': 'comment' } }));
    press(keys.letter('E'), element('li', { attrs: { 'data-shortcut-scope': 'settings-row' } }));
    press(keys.letter('J'));
    expect([reply.mock.calls.length, edit.mock.calls.length, next.mock.calls.length]).toEqual([
      1, 1, 1,
    ]);
    // Neither component scope is active without focus inside it.
    press(keys.letter('R'));
    press(keys.letter('E'));
    expect(reply).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledOnce();
  });
});
