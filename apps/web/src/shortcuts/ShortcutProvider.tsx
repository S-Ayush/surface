// Mounts the shortcut engine (SPEC-005 §5) and the command handler registry for the app. Mount once,
// inside <OverlayProvider> (the engine asks the overlay manager about open layers and Esc).
import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import { keyLabels, overlayManager, toast, usePlatform, type Platform } from '@surface/ui';
import { commandTitle, type CommandId } from '../commands/catalog.js';
import { CommandRegistry, useCommandHandler, type CommandOptions } from '../commands/registry.js';
import { canSubmitFocusedDialog, submitFocusedDialog } from './dialogSubmit.js';
import { ShortcutEngine, type EngineDeps } from './engine.js';
import { SHORTCUTS, inBuild, type Scope, type Shortcut } from './registry.js';

/** How long the "not available here" hint stays (SPEC-005 §5: subtle). */
export const UNAVAILABLE_HINT_MS = 2000;
const HINT_TOAST_ID = 'shortcut-hint';

/** Page scopes from usePageScope, newest (most specific) first. */
export class ScopeStack {
  #entries: { readonly scope: Scope }[] = [];

  push(scope: Scope): () => void {
    const entry = { scope };
    this.#entries = [...this.#entries, entry];
    return () => {
      this.#entries = this.#entries.filter((other) => other !== entry);
    };
  }

  current(): Scope[] {
    return this.#entries.map((entry) => entry.scope).reverse();
  }
}

const label = (chord: string, platform: Platform) => keyLabels(chord, platform).join('');

/** Hints are toasts that replace each other (one id), so they never stack up. */
export function toastHints(platform: Platform): EngineDeps['hints'] {
  return {
    sequence(prefix, next) {
      const lead = prefix.map((chord) => label(chord, platform)).join(' ');
      const options = next.map((binding) => {
        const rest = binding.keys.slice(prefix.length).map((chord) => label(chord, platform));
        return `${rest.join(' ')}: ${commandTitle(binding.command)}`;
      });
      toast({ id: HINT_TOAST_ID, message: `${lead}… ${options.join(', ')}`, duration: Infinity });
    },
    unavailable(binding, reason) {
      // A toast raised over an overlay would wait until it closes, long after the key press.
      if (overlayManager.topLayer() !== undefined) return;
      toast({
        id: HINT_TOAST_ID,
        message: reason ?? `${commandTitle(binding.command)} isn't available here`,
        duration: UNAVAILABLE_HINT_MS,
      });
    },
    clear() {
      toast.dismiss(HINT_TOAST_ID);
    },
  };
}

function showCommandError(): void {
  toast({ tone: 'danger', message: "That command didn't finish. Try again." });
}

type ShortcutContextValue = { readonly commands: CommandRegistry; readonly scopes: ScopeStack };
const ShortcutContext = createContext<ShortcutContextValue | null>(null);

export function ShortcutProvider({
  children,
  bindings = SHORTCUTS,
}: {
  children: ReactNode;
  /**
   * Defaults to the registry. Pass a stable array (a module constant or a memo): a new array
   * rebuilds the engine, which drops a sequence in progress.
   */
  bindings?: readonly Shortcut[];
}) {
  const platform = usePlatform();
  const [value] = useState<ShortcutContextValue>(() => ({
    commands: new CommandRegistry(showCommandError),
    scopes: new ScopeStack(),
  }));

  useEffect(() => {
    const engine = new ShortcutEngine({
      platform,
      bindings: inBuild(bindings),
      commands: value.commands,
      overlay: overlayManager,
      pageScopes: () => value.scopes.current(),
      hints: toastHints(platform),
    });
    const listener = (event: KeyboardEvent) => {
      engine.handleKeydown(event);
    };
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
      engine.dispose();
    };
  }, [platform, bindings, value]);

  useCommandHandler(value.commands, 'ui:submit-dialog', () => submitFocusedDialog(), {
    when: () => canSubmitFocusedDialog(),
  });

  return <ShortcutContext value={value}>{children}</ShortcutContext>;
}

function useShortcutContext(): ShortcutContextValue {
  const value = use(ShortcutContext);
  if (value === null) throw new Error('Wrap the app in <ShortcutProvider>');
  return value;
}

/** Implements a command (and so its shortcuts) while the calling component is mounted. */
export function useCommand(
  id: CommandId,
  run: () => void | Promise<void>,
  options?: CommandOptions,
): void {
  useCommandHandler(useShortcutContext().commands, id, run, options);
}

/** The app's command handlers, for code that lists or runs commands (the command menu). */
export function useCommandRegistry(): CommandRegistry {
  return useShortcutContext().commands;
}

/**
 * Activates a page scope (shortcuts.md §2: `inbox`, `triage`, `issue-page`) while the page is
 * mounted. Component scopes (`list`, `issue`, `comment`, `settings-row`, `editor`) are not set
 * here: the focused element carries `data-shortcut-scope`, which the engine reads.
 */
export function usePageScope(scope: Scope): void {
  const { scopes } = useShortcutContext();
  useEffect(() => scopes.push(scope), [scopes, scope]);
}
