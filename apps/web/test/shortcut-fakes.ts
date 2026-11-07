// DOM-free fakes for the shortcut engine tests: elements that answer `closest()` for attribute
// selectors, key events from real layouts, and an engine wired to spies.
import { vi } from 'vitest';
import type { Platform } from '@surface/ui';
import { CommandRegistry } from '../src/commands/registry.js';
import type { KeyInput } from '../src/shortcuts/chord.js';
import { ShortcutEngine, type EngineDeps, type TargetLike } from '../src/shortcuts/engine.js';
import { SHORTCUTS, type Scope, type Shortcut } from '../src/shortcuts/registry.js';

type FakeElement = TargetLike & {
  readonly attrs: Readonly<Record<string, string>>;
  readonly parent: FakeElement | undefined;
};

/** Matches `[name]` and `[name="value"]` (all the engine asks for). */
function matches(element: FakeElement, selector: string): boolean {
  return selector.split(',').some((part) => {
    const match = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part.trim());
    if (match === null) throw new Error(`Fake closest() cannot match ${part}`);
    const [, name = '', value] = match;
    const actual = element.attrs[name];
    return actual !== undefined && (value === undefined || actual === value);
  });
}

export function element(
  tagName: string,
  options: {
    attrs?: Record<string, string>;
    parent?: FakeElement;
    type?: string;
    contentEditable?: boolean;
  } = {},
): FakeElement {
  const self: FakeElement = {
    tagName: tagName.toUpperCase(),
    ...(options.type === undefined ? {} : { type: options.type }),
    isContentEditable: options.contentEditable ?? options.parent?.isContentEditable ?? false,
    attrs: options.attrs ?? {},
    parent: options.parent,
    parentElement: options.parent ?? null,
    getAttribute: (name) => self.attrs[name] ?? null,
    closest(selector) {
      let current: FakeElement | undefined = self;
      while (current !== undefined) {
        if (matches(current, selector)) return current;
        current = current.parent;
      }
      return null;
    },
  };
  return self;
}

export const body = element('body');

export type FakeEvent = KeyInput & {
  target: unknown;
  defaultPrevented: boolean;
  preventDefault(): void;
};

export function keydown(
  init: Partial<KeyInput> & { key: string },
  target: unknown = body,
): FakeEvent {
  return {
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
    target,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

/** Real keystrokes, by layout (what browsers report for `key` and `code`). */
export const keys = {
  letter: (letter: string, extra: Partial<KeyInput> = {}): Partial<KeyInput> & { key: string } => ({
    key: letter.toLowerCase(),
    code: `Key${letter.toUpperCase()}`,
    ...extra,
  }),
  escape: { key: 'Escape', code: 'Escape' },
  questionMark: { key: '?', code: 'Slash', shiftKey: true },
  bracket: { key: '[', code: 'BracketLeft' },
  modK: (platform: Platform) =>
    platform === 'mac'
      ? { key: 'k', code: 'KeyK', metaKey: true }
      : { key: 'k', code: 'KeyK', ctrlKey: true },
};

export function setup(
  options: {
    platform?: Platform;
    bindings?: readonly Shortcut[];
    layer?: 'modal' | 'popover' | 'menu';
    overlayEscape?: boolean;
    pageScopes?: Scope[];
  } = {},
) {
  const errors: unknown[] = [];
  const commands = new CommandRegistry((error) => errors.push(error));
  const hints = {
    sequence: vi.fn<EngineDeps['hints']['sequence']>(),
    unavailable: vi.fn<EngineDeps['hints']['unavailable']>(),
    clear: vi.fn<EngineDeps['hints']['clear']>(),
  };
  const state = { layer: options.layer, overlayEscape: options.overlayEscape ?? false };
  const deps: EngineDeps = {
    platform: options.platform ?? 'mac',
    bindings: options.bindings ?? SHORTCUTS,
    commands,
    overlay: {
      topLayer: () => (state.layer === undefined ? undefined : { kind: state.layer }),
      isOverlayEscape: () => state.overlayEscape,
    },
    pageScopes: () => options.pageScopes ?? [],
    hints,
  };
  const engine = new ShortcutEngine(deps);
  const press = (init: Partial<KeyInput> & { key: string }, target: unknown = body) => {
    const event = keydown(init, target);
    const taken = engine.handleKeydown(event);
    return { taken, prevented: event.defaultPrevented };
  };
  return { engine, commands, hints, state, errors, press };
}
