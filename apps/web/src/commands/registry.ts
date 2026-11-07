// Runtime handlers for commands (SPEC-005 §5). A feature registers the handler for a command while
// it is mounted. Precedence is explicit, not mount order: React runs a child's effects before its
// parent's, so "newest wins" would let the shell beat a page on a deep-link load and lose to it
// after in-app navigation. The highest level wins; within a level, the newest registration.
import { useEffect, useRef } from 'react';
import type { CommandId } from './catalog.js';

/** Who implements a command: the app shell, a page, or an open overlay (most specific last). */
export const COMMAND_LEVELS = ['app', 'page', 'overlay'] as const;
export type CommandLevel = (typeof COMMAND_LEVELS)[number];

export type CommandHandler = {
  run: () => void | Promise<void>;
  /** Whether the command applies right now (context and permission). Defaults to true. */
  when?: () => boolean;
};

type Entry = { readonly handler: CommandHandler; readonly rank: number; readonly order: number };

export class CommandRegistry {
  readonly #handlers = new Map<CommandId, Entry[]>();
  readonly #onError: (error: unknown) => void;
  #order = 0;

  constructor(onError: (error: unknown) => void) {
    this.#onError = onError;
  }

  register(id: CommandId, handler: CommandHandler, level: CommandLevel = 'app'): () => void {
    const entry: Entry = { handler, rank: COMMAND_LEVELS.indexOf(level), order: ++this.#order };
    this.#handlers.set(id, [...(this.#handlers.get(id) ?? []), entry]);
    return () => {
      this.#handlers.set(
        id,
        (this.#handlers.get(id) ?? []).filter((other) => other !== entry),
      );
    };
  }

  #handler(id: CommandId): CommandHandler | undefined {
    let best: Entry | undefined;
    for (const entry of this.#handlers.get(id) ?? []) {
      if (
        best === undefined ||
        entry.rank > best.rank ||
        (entry.rank === best.rank && entry.order > best.order)
      ) {
        best = entry;
      }
    }
    return best?.handler;
  }

  isAvailable(id: CommandId): boolean {
    const handler = this.#handler(id);
    return handler !== undefined && (handler.when?.() ?? true);
  }

  /** Runs the command if it is available. Failures go to `onError` (a toast in the app). */
  run(id: CommandId): boolean {
    const handler = this.#handler(id);
    if (handler === undefined || !(handler.when?.() ?? true)) return false;
    try {
      const result = handler.run();
      if (result instanceof Promise) result.catch(this.#onError);
    } catch (error) {
      this.#onError(error);
    }
    return true;
  }
}

export type CommandOptions = {
  /** Whether the command applies right now. Read on every key press, so it can change freely. */
  when?: () => boolean;
  /** Defaults to `app`. A page that overrides a shell command passes `page`. */
  level?: CommandLevel;
};

/** Registers `run` (and `when`) for a command while the calling component is mounted. */
export function useCommandHandler(
  registry: CommandRegistry,
  id: CommandId,
  run: () => void | Promise<void>,
  options: CommandOptions = {},
): void {
  const latest = useRef({ run, when: options.when });
  useEffect(() => {
    latest.current = { run, when: options.when };
  });
  const level = options.level ?? 'app';
  // Registered once per id and level: changing `run` or `when` never re-registers, so it never
  // changes the handler's place among others of its level.
  useEffect(
    () =>
      registry.register(
        id,
        { run: () => latest.current.run(), when: () => latest.current.when?.() ?? true },
        level,
      ),
    [registry, id, level],
  );
}
