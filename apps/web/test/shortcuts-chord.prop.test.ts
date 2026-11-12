// SPEC-012 AC-9 (properties of the engine's resolution rules). They are stated on the candidate
// set, not on the number of commands run (which is at most one by construction):
// - after the key-before-code preference, at most one binding per scope accepts an event;
// - when a binding that matches by `event.key` exists, no binding that matches by `event.code`
//   stays a candidate;
// - a less specific binding runs only when every more specific matching binding is unavailable.
// Fixed seed for CI.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { COMMANDS, isCommandId, type CommandId } from '../src/commands/catalog.js';
import { CommandRegistry } from '../src/commands/registry.js';
import { matchesByCode, matchesChord } from '../src/shortcuts/chord.js';
import { ShortcutEngine, componentScopes, type EngineDeps } from '../src/shortcuts/engine.js';
import {
  SCOPES,
  SHORTCUTS,
  forPlatform,
  inBuild,
  type Scope,
  type Shortcut,
} from '../src/shortcuts/registry.js';
import { element, keydown } from './shortcut-fakes.js';

const SEED = 20261112;
const bindings = inBuild(SHORTCUTS, 'M1');
const KEYS = ['a', 'j', 's', 'T', '.', ',', "'", '#', '?', '1', '7', '!', '&', 'Enter', 'ArrowUp'];
const CODES = ['KeyA', 'KeyJ', 'KeyS', 'KeyT', 'Period', 'Comma', 'Quote', 'Digit1', 'Digit7'];
const PAGE_SCOPES = SCOPES.filter(
  (scope) => scope !== 'global' && scope !== 'modal' && scope !== 'picker',
);
const COMPONENT_SCOPES: readonly Scope[] = ['list', 'issue', 'comment', 'settings-row', 'editor'];
const COMMAND_IDS = Object.keys(COMMANDS).filter(isCommandId);

const eventArb = fc.record({
  key: fc.constantFrom(...KEYS),
  code: fc.constantFrom(...CODES),
  metaKey: fc.boolean(),
  ctrlKey: fc.boolean(),
  altKey: fc.boolean(),
  shiftKey: fc.boolean(),
});
const pageScopesArb = fc.subarray(PAGE_SCOPES);
const focusArb = fc.option(fc.constantFrom(...COMPONENT_SCOPES), { nil: undefined });
const platformArb = fc.constantFrom<'mac' | 'other'>('mac', 'other');

const hints: EngineDeps['hints'] = {
  sequence: () => undefined,
  unavailable: () => undefined,
  clear: () => undefined,
};
const overlay: EngineDeps['overlay'] = { topLayer: () => undefined, isOverlayEscape: () => false };

function build(
  platform: 'mac' | 'other',
  pageScopes: readonly Scope[],
  commands: CommandRegistry,
  list: readonly Shortcut[] = bindings,
) {
  return new ShortcutEngine({
    platform,
    bindings: list,
    commands,
    overlay,
    pageScopes: () => [...pageScopes],
    hints,
  });
}

const targetFor = (focus: Scope | undefined) =>
  element('div', focus === undefined ? {} : { attrs: { 'data-shortcut-scope': focus } });

/** What the engine should consider for an event, written from the rules and not from its code. */
function expectedCandidates(
  init: Parameters<typeof keydown>[0],
  platform: 'mac' | 'other',
  pageScopes: readonly Scope[],
  focus: Scope | undefined,
  list: readonly Shortcut[] = bindings,
): Shortcut[] {
  const event = keydown(init, targetFor(focus));
  const active = new Set<Scope>(['global', ...pageScopes, ...componentScopes(event.target)]);
  const matching = forPlatform(list, platform).filter((binding) => {
    const first = binding.chords[0];
    return first !== undefined && active.has(binding.scope) && matchesChord(event, first, platform);
  });
  const byKey = matching.filter((binding) => {
    const first = binding.chords[0];
    return first !== undefined && !matchesByCode(first);
  });
  return byKey.length > 0 ? byKey : matching;
}

// 60 s: the properties run thousands of cases and exceed the 5 s default when the machine is busy.
describe('AC-9: how the engine resolves one key event', { timeout: 60_000 }, () => {
  it('leaves at most one candidate per scope, whatever the layout, platform and scopes', () => {
    fc.assert(
      fc.property(
        eventArb,
        pageScopesArb,
        focusArb,
        platformArb,
        (init, pages, focus, platform) => {
          const engine = build(platform, pages, new CommandRegistry(() => undefined));
          const candidates = engine.candidatesFor(keydown(init, targetFor(focus)));
          const scopes = candidates.map((binding) => binding.scope);
          expect(new Set(scopes).size, candidates.map((c) => c.id).join(', ')).toBe(scopes.length);
        },
      ),
      { seed: SEED, numRuns: 3000 },
    );
  });

  it('keeps exactly the matching bindings, and only the key matches when there is one', () => {
    fc.assert(
      fc.property(
        eventArb,
        pageScopesArb,
        focusArb,
        platformArb,
        (init, pages, focus, platform) => {
          const engine = build(platform, pages, new CommandRegistry(() => undefined));
          const got = engine.candidatesFor(keydown(init, targetFor(focus))).map((b) => b.id);
          const want = expectedCandidates(init, platform, pages, focus).map((b) => b.id);
          expect([...got].sort()).toEqual([...want].sort());
          // A key match and a code match together: the code match is never left.
          const hasKeyMatch = got.some((id) => {
            const first = bindings.find((binding) => binding.id === id)?.chords[0];
            return first !== undefined && !matchesByCode(first);
          });
          if (hasKeyMatch) {
            for (const id of got) {
              const first = bindings.find((binding) => binding.id === id)?.chords[0];
              expect(first !== undefined && matchesByCode(first), id).toBe(false);
            }
          }
        },
      ),
      { seed: SEED, numRuns: 3000 },
    );
  });

  it('a key match beats a code match: Ctrl+Shift+Comma typed as "." runs Mod+. only', () => {
    fc.assert(
      fc.property(platformArb, (platform) => {
        const ran: CommandId[] = [];
        const commands = new CommandRegistry(() => undefined);
        commands.register('issue:copy-id', { run: () => void ran.push('issue:copy-id') });
        commands.register('issue:copy-url', { run: () => void ran.push('issue:copy-url') });
        const engine = build(platform, [], commands);
        const mods = platform === 'mac' ? { metaKey: true } : { ctrlKey: true };
        const row = element('div', { attrs: { 'data-shortcut-scope': 'issue' } });
        engine.handleKeydown(keydown({ key: '.', code: 'Comma', shiftKey: true, ...mods }, row));
        expect(ran).toEqual(['issue:copy-id']);
      }),
      { seed: SEED },
    );
  });

  it('runs a less specific binding only when every more specific matching one is unavailable', () => {
    fc.assert(
      fc.property(
        eventArb,
        pageScopesArb,
        focusArb,
        platformArb,
        fc.subarray(COMMAND_IDS),
        (init, pages, focus, platform, availableIds) => {
          const ran: CommandId[] = [];
          const commands = new CommandRegistry(() => undefined);
          const available = new Set<CommandId>(availableIds);
          for (const id of COMMAND_IDS) {
            commands.register(id, { run: () => void ran.push(id), when: () => available.has(id) });
          }
          const engine = build(platform, pages, commands);
          const event = keydown(init, targetFor(focus));
          const candidates = engine.candidatesFor(event);
          const best = candidates[0];
          // A sequence's first key only starts it; a native binding is the editor's to handle.
          fc.pre(best !== undefined && best.chords.length === 1 && best.native !== true);
          engine.handleKeydown(event);
          const expected = candidates.find(
            (binding) => binding.native !== true && available.has(binding.command),
          );
          expect(ran).toEqual(expected === undefined ? [] : [expected.command]);
          if (expected !== undefined) {
            const before = candidates.slice(0, candidates.indexOf(expected));
            for (const skipped of before) {
              expect(skipped.native === true || !available.has(skipped.command), skipped.id).toBe(
                true,
              );
            }
          }
        },
      ),
      { seed: SEED, numRuns: 3000 },
    );
  });
});
