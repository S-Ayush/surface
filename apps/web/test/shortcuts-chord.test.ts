// SPEC-012 AC-9 and E14: position-based matching (digits, Alt, Shift with a non-letter) and the
// `event.key`-first rule, as a table of synthetic events per keyboard layout.
import { describe, expect, it } from 'vitest';
import { matchesChord, toChord, type KeyInput } from '../src/shortcuts/chord.js';
import { SHORTCUTS, inBuild, type Shortcut } from '../src/shortcuts/registry.js';
import { ShortcutEngine } from '../src/shortcuts/engine.js';
import { CommandRegistry } from '../src/commands/registry.js';
import { element, keydown, setup } from './shortcut-fakes.js';

type Init = Partial<KeyInput> & { key: string; code: string };

const matches = (event: Init, chord: string, platform: 'mac' | 'other') =>
  matchesChord(keydown(event), toChord(chord), platform);

describe('toChord: which chords match by position', () => {
  it.each([
    ['Ctrl+Shift+1', 'Digit1'],
    ['Mod+Shift+7', 'Digit7'],
    ['Mod+Alt+0', 'Digit0'],
    ['Mod+Shift+.', 'Period'],
    ['Mod+Shift+,', 'Comma'],
    ["Mod+Shift+'", 'Quote'],
    ['Mod+Shift+\\', 'Backslash'],
    ['Alt+Shift+.', 'Period'],
    ['Alt+T', 'KeyT'],
    ['Mod+Alt+C', 'KeyC'],
    ['Mod+K', 'KeyK'],
  ])('%s matches %s', (text, code) => {
    expect(toChord(text).code).toBe(code);
  });

  it.each(['Mod+,', 'Mod+.', '#', '?', '[', 'J', 'Shift+E', 'Enter', 'Alt+ArrowUp'])(
    '%s matches what the key types',
    (text) => {
      expect(toChord(text).code).toBeUndefined();
    },
  );
});

describe('AC-9: per layout', () => {
  // A table of what each layout reports for the key that types the character (key, code, modifiers).
  it.each([
    ['US', { key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }],
    ['AZERTY', { key: '1', code: 'Digit1', ctrlKey: true, shiftKey: true }],
    ['QWERTZ', { key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }],
    ['Russian', { key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }],
  ] as [string, Init][])('%s: Ctrl+Shift+1 matches Digit1 whatever the key types', (_, event) => {
    expect(matches(event, 'Ctrl+Shift+1', 'mac')).toBe(true);
    expect(matches(event, 'Ctrl+Shift+1', 'other')).toBe(true);
  });

  it.each([
    ['US', { key: '&', code: 'Digit7', metaKey: true, shiftKey: true }],
    ['AZERTY', { key: '7', code: 'Digit7', metaKey: true, shiftKey: true }],
    ['QWERTZ', { key: '/', code: 'Digit7', metaKey: true, shiftKey: true }],
    ['Russian', { key: '?', code: 'Digit7', metaKey: true, shiftKey: true }],
  ] as [string, Init][])('%s: Mod+Shift+7 matches Digit7', (_, event) => {
    expect(matches(event, 'Mod+Shift+7', 'mac')).toBe(true);
  });

  it('Alt+T and Mod+Alt+C match the physical key when macOS Option changes event.key', () => {
    expect(matches({ key: '†', code: 'KeyT', altKey: true }, 'Alt+T', 'mac')).toBe(true);
    expect(
      matches({ key: 'ç', code: 'KeyC', metaKey: true, altKey: true }, 'Mod+Alt+C', 'mac'),
    ).toBe(true);
    // Russian: the key types "е" but sits on KeyT.
    expect(matches({ key: 'е', code: 'KeyT', altKey: true }, 'Alt+T', 'other')).toBe(true);
  });

  it('# matches on event.key, on every layout', () => {
    expect(matches({ key: '#', code: 'Digit3', shiftKey: true }, '#', 'mac')).toBe(true); // US
    expect(matches({ key: '#', code: 'Backslash' }, '#', 'mac')).toBe(true); // QWERTZ
    expect(matches({ key: '#', code: 'Quote', altKey: true }, '#', 'mac')).toBe(true); // Option
    expect(matches({ key: '3', code: 'Digit3' }, '#', 'mac')).toBe(false);
  });

  it('Mod+, opens Settings on every layout, AZERTY included (the KeyM key with Ctrl)', () => {
    const { commands, press } = setup({ platform: 'other' });
    let opened = 0;
    commands.register('nav:settings', {
      run: () => {
        opened += 1;
      },
    });
    press({ key: ',', code: 'Comma', ctrlKey: true }); // US, QWERTZ
    press({ key: ',', code: 'KeyM', ctrlKey: true }); // AZERTY
    press({ key: 'б', code: 'Comma', ctrlKey: true }); // Russian types "б": no match, as before
    expect(opened).toBe(2);
  });

  it("Mod+Shift+. , Mod+Shift+, and Mod+Shift+' match the US physical keys with Shift", () => {
    expect(
      matches({ key: '>', code: 'Period', metaKey: true, shiftKey: true }, 'Mod+Shift+.', 'mac'),
    ).toBe(true);
    expect(
      matches({ key: '<', code: 'Comma', metaKey: true, shiftKey: true }, 'Mod+Shift+,', 'mac'),
    ).toBe(true);
    expect(
      matches({ key: '"', code: 'Quote', metaKey: true, shiftKey: true }, "Mod+Shift+'", 'mac'),
    ).toBe(true);
    // Without Shift, or on another key, they do not.
    expect(matches({ key: '.', code: 'Period', metaKey: true }, 'Mod+Shift+.', 'mac')).toBe(false);
    expect(
      matches({ key: '>', code: 'Comma', metaKey: true, shiftKey: true }, 'Mod+Shift+.', 'mac'),
    ).toBe(false);
  });

  it('AZERTY Ctrl+. (typed as Ctrl+Shift+Comma) runs Mod+. and never Mod+Shift+,', () => {
    const { commands, press } = setup({ platform: 'other', bindings: inBuild(SHORTCUTS, 'M1') });
    const ran: string[] = [];
    commands.register('issue:copy-id', { run: () => void ran.push('id') });
    commands.register('issue:copy-url', { run: () => void ran.push('url') });
    const row = element('div', { attrs: { 'data-shortcut-scope': 'issue' } });
    // The AZERTY "." key needs Shift and sits on the Comma position.
    press({ key: '.', code: 'Comma', ctrlKey: true, shiftKey: true }, row);
    expect(ran).toEqual(['id']);
    // The US Ctrl+Shift+, types "<" on the same position: that one is Copy URL.
    press({ key: '<', code: 'Comma', ctrlKey: true, shiftKey: true }, row);
    expect(ran).toEqual(['id', 'url']);
  });
});

describe('Ctrl is not Mod', () => {
  it('on macOS Ctrl+M does not fire on Cmd+M, and Cmd+M does not fire on Ctrl+M', () => {
    expect(matches({ key: 'm', code: 'KeyM', metaKey: true }, 'Ctrl+M', 'mac')).toBe(false);
    expect(matches({ key: 'm', code: 'KeyM', ctrlKey: true }, 'Ctrl+M', 'mac')).toBe(true);
    expect(matches({ key: 'm', code: 'KeyM', ctrlKey: true }, 'Mod+M', 'mac')).toBe(false);
  });
  it('elsewhere Ctrl and Mod are the same key', () => {
    expect(matches({ key: 'm', code: 'KeyM', ctrlKey: true }, 'Ctrl+M', 'other')).toBe(true);
    expect(matches({ key: 'm', code: 'KeyM', ctrlKey: true }, 'Mod+M', 'other')).toBe(true);
  });
});

describe('the engine is built from the registry', () => {
  it('can be created for every binding without throwing', () => {
    const bindings: readonly Shortcut[] = inBuild(SHORTCUTS, 'M1');
    for (const platform of ['mac', 'other'] as const) {
      expect(
        () =>
          new ShortcutEngine({
            platform,
            bindings,
            commands: new CommandRegistry(() => undefined),
            overlay: { topLayer: () => undefined, isOverlayEscape: () => false },
            pageScopes: () => [],
            hints: {
              sequence: () => undefined,
              unavailable: () => undefined,
              clear: () => undefined,
            },
          }),
      ).not.toThrow();
    }
  });
});
