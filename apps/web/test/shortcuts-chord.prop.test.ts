// SPEC-012 AC-9 (property): no key event ever runs two bindings, and a chord that matches by
// `event.key` wins over one that matches by `event.code`. Fixed seed for CI.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { COMMANDS, isCommandId, type CommandId } from '../src/commands/catalog.js';
import { CommandRegistry } from '../src/commands/registry.js';
import { ShortcutEngine, type EngineDeps } from '../src/shortcuts/engine.js';
import { SCOPES, SHORTCUTS, inBuild } from '../src/shortcuts/registry.js';
import { element, keydown } from './shortcut-fakes.js';

const bindings = inBuild(SHORTCUTS, 'M1');
const KEYS = ['a', 'j', 's', 'T', '.', ',', "'", '#', '?', '1', '7', '!', '&', 'Enter', 'ArrowUp'];
const CODES = ['KeyA', 'KeyJ', 'KeyS', 'KeyT', 'Period', 'Comma', 'Quote', 'Digit1', 'Digit7'];
const PAGE_SCOPES = SCOPES.filter(
  (scope) => scope !== 'global' && scope !== 'modal' && scope !== 'picker',
);

const eventArb = fc.record({
  key: fc.constantFrom(...KEYS),
  code: fc.constantFrom(...CODES),
  metaKey: fc.boolean(),
  ctrlKey: fc.boolean(),
  altKey: fc.boolean(),
  shiftKey: fc.boolean(),
});
const scopesArb = fc.subarray(PAGE_SCOPES);
const platformArb = fc.constantFrom<'mac' | 'other'>('mac', 'other');

const hints: EngineDeps['hints'] = {
  sequence: () => undefined,
  unavailable: () => undefined,
  clear: () => undefined,
};
const overlay: EngineDeps['overlay'] = { topLayer: () => undefined, isOverlayEscape: () => false };

describe('AC-9: one key event never runs two bindings', () => {
  it('runs at most one command per event, whatever the layout, platform and scopes', () => {
    fc.assert(
      fc.property(eventArb, scopesArb, platformArb, (init, scopes, platform) => {
        const ran: CommandId[] = [];
        const commands = new CommandRegistry(() => undefined);
        for (const id of Object.keys(COMMANDS)) {
          if (!isCommandId(id)) continue;
          commands.register(id, { run: () => void ran.push(id) });
        }
        const engine = new ShortcutEngine({
          platform,
          bindings,
          commands,
          overlay,
          pageScopes: () => scopes,
          hints,
        });
        engine.handleKeydown(keydown({ ...init }, element('div')));
        engine.dispose();
        expect(ran.length).toBeLessThanOrEqual(1);
      }),
      { seed: 20261112, numRuns: 2000 },
    );
  });

  it('a key match beats a code match: Ctrl+Shift+Comma typed as "." runs Mod+. only', () => {
    fc.assert(
      fc.property(platformArb, (platform) => {
        const ran: CommandId[] = [];
        const commands = new CommandRegistry(() => undefined);
        commands.register('issue:copy-id', { run: () => void ran.push('issue:copy-id') });
        commands.register('issue:copy-url', { run: () => void ran.push('issue:copy-url') });
        const engine = new ShortcutEngine({
          platform,
          bindings,
          commands,
          overlay,
          pageScopes: () => [],
          hints,
        });
        const mods = platform === 'mac' ? { metaKey: true } : { ctrlKey: true };
        const row = element('div', { attrs: { 'data-shortcut-scope': 'issue' } });
        engine.handleKeydown(keydown({ key: '.', code: 'Comma', shiftKey: true, ...mods }, row));
        expect(ran).toEqual(['issue:copy-id']);
      }),
      { seed: 20261112 },
    );
  });
});
