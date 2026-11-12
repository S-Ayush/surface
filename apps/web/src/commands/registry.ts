// Runtime handlers for commands (SPEC-005 §5). A feature registers the handler for a command while
// it is mounted. Precedence is explicit, not mount order: React runs a child's effects before its
// parent's, so "newest wins" would let the shell beat a page on a deep-link load and lose to it
// after in-app navigation. The highest level wins; within a level, the newest registration.
import { observable, runInAction } from 'mobx';
import { useEffect, useRef } from 'react';
import type { CommandId } from './catalog.js';

/** Who implements a command: the app shell, a page, or an open overlay (most specific last). */
export const COMMAND_LEVELS = ['app', 'page', 'overlay'] as const;
export type CommandLevel = (typeof COMMAND_LEVELS)[number];

export type CommandHandler = {
  run: () => void | Promise<void>;
  /** Whether the command applies right now (context and permission). Defaults to true. */
  when?: () => boolean;
  /** Why it does not apply right now, shown by the shortcut hint ("ENG-42 is archived. …"). */
  reason?: () => string | undefined;
};

type Entry = { readonly handler: CommandHandler; readonly rank: number; readonly order: number };

export class CommandRegistry {
  readonly #handlers = new Map<CommandId, Entry[]>();
  readonly #onError: (error: unknown) => void;
  #order = 0;
  /**
   * Bumped on every registration change. `isAvailable` reads it, so a MobX reaction (the open
   * command menu) sees a handler come or go.
   */
  readonly #revision = observable.box(0);

  constructor(onError: (error: unknown) => void) {
    this.#onError = onError;
  }

  register(id: CommandId, handler: CommandHandler, level: CommandLevel = 'app'): () => void {
    const entry: Entry = { handler, rank: COMMAND_LEVELS.indexOf(level), order: ++this.#order };
    this.#handlers.set(id, [...(this.#handlers.get(id) ?? []), entry]);
    this.#changed();
    return () => {
      this.#handlers.set(
        id,
        (this.#handlers.get(id) ?? []).filter((other) => other !== entry),
      );
      this.#changed();
    };
  }

  #changed(): void {
    runInAction(() => this.#revision.set(this.#revision.get() + 1));
  }

  /**
   * The handler for a command: the highest-ranked one that applies right now, so a page's Esc step
   * that does not apply here falls to the next step (SPEC-012 §4.2 "Esc chain"). If none applies,
   * the highest-ranked one, so its `reason` can explain why.
   */
  #handler(id: CommandId): CommandHandler | undefined {
    this.#revision.get();
    const entries = [...(this.#handlers.get(id) ?? [])].sort(
      (a, b) => b.rank - a.rank || b.order - a.order,
    );
    return (entries.find((entry) => entry.handler.when?.() ?? true) ?? entries[0])?.handler;
  }

  isAvailable(id: CommandId): boolean {
    const handler = this.#handler(id);
    return handler !== undefined && (handler.when?.() ?? true);
  }

  /** Why the command is unavailable now, when its handler says (SPEC-005 §5 "not available here"). */
  reason(id: CommandId): string | undefined {
    const handler = this.#handler(id);
    if (handler === undefined || (handler.when?.() ?? true)) return undefined;
    return handler.reason?.();
  }

  /**
   * Runs the command's handler and returns its result, so the caller handles failures (the command
   * menu shows them inline after Mod+Enter). Throws if the command is not available.
   */
  invoke(id: CommandId): void | Promise<void> {
    const handler = this.#handler(id);
    if (handler === undefined || !(handler.when?.() ?? true)) {
      throw new Error(`Command ${id} is not available`);
    }
    return handler.run();
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
  /** Why the command is unavailable, for the shortcut hint (read only while `when` is false). */
  reason?: () => string | undefined;
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
  const latest = useRef({ run, when: options.when, reason: options.reason });
  useEffect(() => {
    latest.current = { run, when: options.when, reason: options.reason };
  });
  const level = options.level ?? 'app';
  // Registered once per id and level: changing `run` or `when` never re-registers, so it never
  // changes the handler's place among others of its level.
  useEffect(
    () =>
      registry.register(
        id,
        {
          run: () => latest.current.run(),
          when: () => latest.current.when?.() ?? true,
          reason: () => latest.current.reason?.(),
        },
        level,
      ),
    [registry, id, level],
  );
}
