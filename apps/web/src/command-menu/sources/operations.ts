// Operation commands (SPEC-005 §4.1, command-menu.md §2): one per registry operation with `ui`
// metadata. `when` = the operation's `ui.contexts` match the target, and the client-side
// permission pre-check passes (the shared predicates, on the signed-in actor). The server still
// decides: the pre-check only hides what would be refused.
import { bindPredicates, userActor, type ResolvedRefs } from '@surface/domain';
import type { AnyOperation, OperationRegistry, UiContext } from '@surface/operations';
import type { CommandId } from '../../commands/catalog.js';
import { CommandRegistry } from '../../commands/registry.js';
import type {
  Command,
  CommandContext,
  CommandPage,
  CommandSource,
  CommandTarget,
} from '../model.js';
import { GLOBAL_TARGET } from '../model.js';
import { isBound } from './shortcuts.js';

/**
 * How the menu runs an operation: what it acts on, and how it gets its input. Every operation
 * with `ui` needs an entry in `features/commands.ts` (checked by test/command-operations.test.ts).
 * Exactly one of `run`, `page` or `opens`.
 */
export type OperationCommand = {
  readonly section?: Command['section'];
  /** References for the permission pre-check, from the target: `{ team: row }`. */
  readonly refs?: (ctx: CommandContext) => ResolvedRefs;
} & (
  | { readonly run: (ctx: CommandContext, op: AnyOperation) => void | Promise<void> }
  | { readonly page: (ctx: CommandContext, op: AnyOperation) => CommandPage }
  /** An app command that opens the operation's form ("Create team…"), registered by its feature. */
  | { readonly opens: CommandId }
);

/** Operations the menu lists: with `ui`, not internal, not deprecated. */
export function menuOperations(registry: OperationRegistry): AnyOperation[] {
  return registry
    .list()
    .filter((op) => op.ui !== undefined && op.internal !== true && op.deprecated === undefined);
}

export function matchesContext(contexts: readonly UiContext[], target: CommandTarget): boolean {
  return (
    contexts.includes('global') || (target.kind !== 'global' && contexts.includes(target.kind))
  );
}

/** The pre-check: false without a signed-in actor or when the predicates refuse. */
export function permits(op: AnyOperation, ctx: CommandContext, refs: ResolvedRefs): boolean {
  if (ctx.actor === null) return false;
  try {
    // No input yet (it is chosen in the menu or a form); predicates that need it are the
    // server's to decide, so a throwing check does not hide the command.
    return op.permission(bindPredicates(ctx.actor).p, refs, {});
  } catch {
    return true;
  }
}

export function operationSource(
  registry: OperationRegistry,
  commands: CommandRegistry,
  implementations: Readonly<Record<string, OperationCommand>>,
): CommandSource {
  return () =>
    menuOperations(registry).flatMap((op): Command[] => {
      const ui = op.ui;
      const impl = implementations[op.name];
      if (ui === undefined || impl === undefined) return [];
      const command: Command = {
        id: `op:${op.name}`,
        title: ui.title,
        section: impl.section ?? (op.name.endsWith('.create') ? 'create' : 'settings'),
        keywords: op.keywords,
        ...(ui.shortcut && isBound(ui.shortcut) ? { shortcuts: [ui.shortcut] } : {}),
        when: (ctx) =>
          matchesContext(ui.contexts, ctx.target) &&
          permits(op, ctx, impl.refs?.(ctx) ?? {}) &&
          ('opens' in impl ? commands.isAvailable(impl.opens) : true),
        // Acts on the target itself: a global command applies only when there is no target.
        appliesTo: (ctx) => ui.contexts.includes(ctx.target.kind),
      };
      if ('run' in impl) return [{ ...command, run: (ctx) => impl.run(ctx, op) }];
      if ('page' in impl) return [{ ...command, page: (ctx) => impl.page(ctx, op) }];
      return [{ ...command, run: () => commands.invoke(impl.opens) }];
    });
}

/** A user every permission allows: an Admin who is also a member of the target team. */
const CHECK_ACTOR = userActor({
  userId: 'check-user',
  role: 'admin',
  memberships: [{ teamId: 'check', private: false }],
});

/** A target of `kind` for the check: the entity `check`, which CHECK_ACTOR may act on. */
function checkTarget(kind: UiContext): CommandTarget {
  return kind === 'global' ? GLOBAL_TARGET : { kind, ids: ['check'], label: 'CHECK' };
}

/**
 * Problems with the command entries for `registry`'s operations (run by
 * test/command-operations.test.ts on the real registry): every operation with `ui` metadata has
 * exactly one entry; an entry for an operation that acts on an entity gives `refs` (without them a
 * team-scoped permission refuses every Member); its shortcut is bound in this build; and a user
 * every permission allows is offered it in its first context, with any form it opens registered.
 */
export function checkOperationCommands(
  registry: OperationRegistry,
  implementations: Readonly<Record<string, OperationCommand>>,
): string[] {
  const problems: string[] = [];
  const operations = menuOperations(registry);
  const names = new Set(operations.map((op) => op.name));
  for (const name of Object.keys(implementations)) {
    if (!names.has(name)) problems.push(`${name} has a command entry but no operation with ui`);
  }
  for (const op of operations) {
    const ui = op.ui;
    const impl = implementations[op.name];
    if (ui === undefined) continue;
    if (impl === undefined) {
      problems.push(`${op.name} has ui metadata but no command entry`);
      continue;
    }
    if (ui.contexts.some((kind) => kind !== 'global') && impl.refs === undefined) {
      problems.push(`${op.name} acts on ${ui.contexts.join('/')} but gives no refs`);
    }
    if (ui.shortcut && !isBound(ui.shortcut)) {
      problems.push(`${op.name} shows ${ui.shortcut}, which no shortcut binding uses`);
    }
    const commands = new CommandRegistry(() => undefined);
    if ('opens' in impl) commands.register(impl.opens, { run: () => undefined });
    const ctx: CommandContext = {
      route: '/',
      target: checkTarget(ui.contexts[0] ?? 'global'),
      actor: CHECK_ACTOR,
      store: null,
      teams: () => [],
    };
    const command = operationSource(registry, commands, { [op.name]: impl })(ctx)[0];
    if (command === undefined || !(command.when?.(ctx) ?? true)) {
      problems.push(`${op.name} is not offered in its ${ui.contexts[0] ?? ''} context`);
    }
  }
  return problems;
}
