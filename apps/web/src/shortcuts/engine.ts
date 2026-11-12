// The shortcut engine (SPEC-005 §5): one document `keydown` listener resolves a key against the
// active scopes, most specific first (overlay, then focused component, then page, then global),
// handles sequences ("G S", 1 s) and suppresses plain keys while the user types.
import type { Platform } from '@surface/ui';
import type { CommandId } from '../commands/catalog.js';
import {
  MODIFIER_KEYS,
  isCommandChord,
  matchesByCode,
  matchesChord,
  type Chord,
  type KeyInput,
} from './chord.js';
import { SCOPES, forPlatform, type Scope, type Shortcut } from './registry.js';

/** shortcuts.md rule 3: a sequence must be finished within 1 s. */
export const SEQUENCE_TIMEOUT_MS = 1000;

/** The attribute a focusable component sets to activate its scope: `data-shortcut-scope="list"`. */
export const SCOPE_ATTRIBUTE = 'data-shortcut-scope';

/** The event target, read structurally so the engine runs without a DOM in tests. */
export type TargetLike = {
  readonly tagName?: string;
  readonly type?: string;
  readonly isContentEditable?: boolean;
  closest?(selector: string): TargetLike | null;
  getAttribute?(name: string): string | null;
  readonly parentElement?: TargetLike | null;
};

export type KeyEventLike = KeyInput & {
  readonly target: unknown;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
};

export type EngineDeps = {
  platform: Platform;
  bindings: readonly Shortcut[];
  commands: {
    isAvailable(id: CommandId): boolean;
    run(id: CommandId): boolean;
    /** Why the command is unavailable right now ("ENG-42 is archived. Restore it to edit it."). */
    reason?(id: CommandId): string | undefined;
  };
  overlay: {
    topLayer(): { readonly kind: 'modal' | 'popover' | 'menu' } | undefined;
    isOverlayEscape(event: object): boolean;
  };
  /** Page scopes, most specific first (usePageScope). */
  pageScopes: () => readonly Scope[];
  hints: {
    /** A sequence started: list what can follow ("G… S: Go to settings"). */
    sequence(prefix: readonly string[], next: readonly Shortcut[]): void;
    /** The binding's command does not apply here. */
    unavailable(binding: Shortcut, reason?: string): void;
    clear(): void;
  };
  timers?: {
    set(callback: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
};

/** Text-like inputs only: a focused checkbox or button does not take typed letters. */
const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

// Any object: every member of TargetLike is optional and read defensively.
const asTarget = (value: unknown): TargetLike | null =>
  typeof value === 'object' && value !== null ? value : null;

const isScope = (value: unknown): value is Scope => SCOPES.some((scope) => scope === value);

/** SPEC-005 §5 input suppression: an input, textarea, select, contenteditable or opt-out area. */
export function isTypingTarget(value: unknown): boolean {
  const target = asTarget(value);
  if (target === null) return false;
  if (target.isContentEditable === true) return true;
  const tag = target.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT' && !NON_TEXT_INPUTS.has((target.type ?? 'text').toLowerCase())) return true;
  return target.closest?.('[data-shortcuts="off"]') != null;
}

/** Component scopes around the focused element, innermost first. */
export function componentScopes(value: unknown): Scope[] {
  const scopes: Scope[] = [];
  let element = asTarget(value)?.closest?.(`[${SCOPE_ATTRIBUTE}]`) ?? null;
  while (element !== null) {
    const scope = element.getAttribute?.(SCOPE_ATTRIBUTE);
    if (isScope(scope)) scopes.push(scope);
    element = element.parentElement?.closest?.(`[${SCOPE_ATTRIBUTE}]`) ?? null;
  }
  return scopes;
}

type KeyContext = {
  readonly scopes: readonly Scope[];
  readonly typing: boolean;
  readonly overlay: boolean;
};

type Pending = { readonly candidates: readonly Shortcut[]; readonly index: number; timer: unknown };

export class ShortcutEngine {
  readonly #deps: EngineDeps;
  /** The bindings that exist on this platform (a `platform: 'mac'` binding is dropped elsewhere). */
  readonly #bindings: readonly Shortcut[];
  readonly #timers: NonNullable<EngineDeps['timers']>;
  #pending: Pending | null = null;

  constructor(deps: EngineDeps) {
    this.#deps = deps;
    this.#bindings = forPlatform(deps.bindings, deps.platform);
    this.#timers = deps.timers ?? {
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  /** Whether a sequence is waiting for its next key. */
  get pendingSequence(): readonly string[] | null {
    const pending = this.#pending;
    const first = pending?.candidates[0];
    return pending && first ? first.keys.slice(0, pending.index) : null;
  }

  /** The document `keydown` listener. Returns whether the key was taken. */
  handleKeydown = (event: KeyEventLike): boolean => {
    // E2: keys that compose text (IME, dead keys) are never shortcuts.
    if (event.isComposing === true || event.keyCode === 229) return false;
    if (MODIFIER_KEYS.has(event.key)) return false;
    if (event.defaultPrevented || event.repeat === true) {
      if (event.defaultPrevented) this.#cancel();
      return false;
    }
    // An overlay took this Esc and has closed itself (S3 handoff: not topLayer(), which is
    // already empty here).
    if (event.key === 'Escape' && this.#deps.overlay.isOverlayEscape(event)) {
      this.#cancel();
      return false;
    }

    const context = this.#context(event);
    const pending = this.#pending;
    if (pending !== null) {
      this.#cancel();
      // Every key of a sequence passes the same gate as the first (AC-5, overlay capture).
      const next = this.#preferKeyMatches(
        pending.candidates.filter((binding) => {
          const chord = binding.chords[pending.index];
          return chord !== undefined && this.#accepts(binding, chord, event, context);
        }),
        pending.index,
      );
      if (next.length > 0) return this.#advance(event, next, pending.index + 1);
      // Not a continuation: the sequence ends and the key is read on its own.
    }

    const candidates = this.#preferKeyMatches(
      context.scopes.flatMap((scope) =>
        this.#bindings.filter((binding) => {
          const first = binding.chords[0];
          return (
            binding.scope === scope &&
            first !== undefined &&
            this.#accepts(binding, first, event, context)
          );
        }),
      ),
      0,
    );
    if (candidates.length === 0) return false;
    return this.#advance(event, candidates, 1);
  };

  dispose(): void {
    this.#cancel();
  }

  /** What is active for this key: scopes most specific first, typing, and an open overlay. */
  #context(event: KeyEventLike): KeyContext {
    const layer = this.#deps.overlay.topLayer();
    const scopes: Scope[] = [];
    if (layer !== undefined) scopes.push(layer.kind === 'modal' ? 'modal' : 'picker');
    scopes.push(...componentScopes(event.target));
    // An open overlay captures the page: its scopes stay inactive until it closes.
    if (layer === undefined) scopes.push(...this.#deps.pageScopes());
    scopes.push('global');
    return {
      scopes: [...new Set(scopes)],
      typing: isTypingTarget(event.target),
      overlay: layer !== undefined,
    };
  }

  /**
   * SPEC-012 §4.2: `event.key` matches are tried before `event.code` matches, so AZERTY `Ctrl+.`
   * (typed as Ctrl+Shift+Comma) runs `Mod+.`, never `Mod+Shift+,`. Scope order is kept.
   */
  #preferKeyMatches(candidates: readonly Shortcut[], index: number): readonly Shortcut[] {
    const byKey = candidates.filter((binding) => {
      const chord = binding.chords[index];
      return chord !== undefined && !matchesByCode(chord);
    });
    return byKey.length > 0 ? byKey : candidates;
  }

  /**
   * Whether this chord of the binding may fire for this key: its scope is active, and, while typing
   * or (for global bindings) over an overlay, it is a Mod chord or Esc. `whileTyping` overrides
   * that per binding (SPEC-012 §4.2): `false` never fires in a text field, `true` always may.
   */
  #accepts(binding: Shortcut, chord: Chord, event: KeyEventLike, context: KeyContext): boolean {
    if (!context.scopes.includes(binding.scope)) return false;
    const plain = !isCommandChord(chord) && chord.key !== 'Escape';
    if (context.typing) {
      if (binding.whileTyping === false) return false;
      if (plain && binding.whileTyping !== true) return false;
    }
    if (plain && context.overlay && binding.scope === 'global') return false;
    return matchesChord(event, chord, this.#deps.platform);
  }

  #advance(event: KeyEventLike, candidates: readonly Shortcut[], index: number): boolean {
    // The most specific scope wins; the conflict test keeps one scope's bindings unambiguous.
    const best = candidates[0];
    if (best === undefined) return false;
    if (best.chords.length === index) {
      return this.#run(
        event,
        candidates.filter((binding) => binding.chords.length === index),
      );
    }
    const longer = candidates.filter((binding) => binding.chords.length > index);
    event.preventDefault();
    const timer = this.#timers.set(() => this.#cancel(), SEQUENCE_TIMEOUT_MS);
    this.#pending = { candidates: longer, index, timer };
    const first = longer[0];
    if (first !== undefined) this.#deps.hints.sequence(first.keys.slice(0, index), longer);
    return true;
  }

  /**
   * Runs the first binding (most specific scope first) whose command is available, so a binding
   * that does not apply here (Mod+Enter outside a checklist item) falls through to the next scope.
   * If none is available the most specific one gives the "not available here" hint.
   */
  #run(event: KeyEventLike, bindings: readonly Shortcut[]): boolean {
    const best = bindings[0];
    if (best === undefined || best.native === true) return false;
    for (const binding of bindings) {
      if (binding.native === true) continue;
      if (this.#deps.commands.run(binding.command)) {
        event.preventDefault();
        return true;
      }
    }
    if (best.quiet === true) return false;
    event.preventDefault();
    const reason = this.#deps.commands.reason?.(best.command);
    if (reason === undefined) this.#deps.hints.unavailable(best);
    else this.#deps.hints.unavailable(best, reason);
    return true;
  }

  #cancel(): void {
    if (this.#pending === null) return;
    this.#timers.clear(this.#pending.timer);
    this.#pending = null;
    this.#deps.hints.clear();
  }
}
