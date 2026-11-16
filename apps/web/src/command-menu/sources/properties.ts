// Property commands (SPEC-005 §4.1 third kind, SPEC-012 §3.8): Change status…, Assign to me,
// Remove due date. Each dispatches one `issue.update` with a partial input. They exist because a
// registry entry has one `ui` entry and `issue.update` has none (SPEC-011 §6.1). The definitions
// live in `features/issues` next to their pickers (PLAN-012 S6); this is the kind and its source.
import type { ResolvedRefs } from '@surface/domain';
import type { OperationRegistry } from '@surface/operations';
import type { CommandId } from '../../commands/catalog.js';
import type { Command, CommandContext, CommandPage, CommandSource } from '../model.js';
import { isAvailableHere, permits } from './operations.js';
import { shortcutsFor } from './shortcuts.js';

/** The target kinds a property command acts on. */
export type PropertyTargetKind = 'issue' | 'issues';

export type PropertyTarget = { readonly kind: PropertyTargetKind; readonly ids: readonly string[] };

export type PropertyCommand = {
  /** "prop:issue.status" */
  readonly id: string;
  /** Sentence case; ends with "…" when it opens a picker ("Change status…"). */
  readonly title: string;
  readonly keywords?: readonly string[];
  /**
   * Where it lists when it is not in Suggested. An offered property command always applies to the
   * target, so this shows only for a destructive command ranked down (ranking.ts). Required so
   * each definition chooses; SPEC-012 §3.8 and command-menu.md §1 name none.
   */
  readonly section: Command['section'];
  readonly appliesTo: readonly PropertyTargetKind[];
  /** The operation it dispatches: the permission pre-check runs on it. Default `issue.update`. */
  readonly operation?: string;
  /**
   * References for the permission pre-check, from the target: `{ issue: row }`. Required: a
   * team-scoped permission refuses every Member without them, and the command would be hidden with
   * no sign of why (the same rule `checkOperationCommands` enforces for operation commands).
   */
  readonly refs: (ctx: CommandContext) => ResolvedRefs;
  /** As `ui.available` (SPEC-003 §3.1): false hides the command, e.g. on an archived issue. */
  readonly available?: (target: PropertyTarget, store: unknown) => boolean;
  readonly destructive?: boolean;
  /** The shortcut command whose keys the row shows as hints (`issue:status` shows `S`). */
  readonly shortcut?: CommandId;
} & (
  | /** Opens the §3.5 picker as a sub-page; choosing an item dispatches the update. */ {
      readonly picker: (ctx: CommandContext) => CommandPage;
    }
  | /** Runs at once (Assign to me, Remove due date). */ {
      readonly run: (ctx: CommandContext) => void | Promise<void>;
    }
);

const DEFAULT_OPERATION = 'issue.update';

const propertyTarget = (ctx: CommandContext): PropertyTarget | null =>
  ctx.target.kind === 'issue' || ctx.target.kind === 'issues'
    ? { kind: ctx.target.kind, ids: ctx.target.ids }
    : null;

/**
 * One command per definition. A command is offered when the target is one it applies to, the
 * operation exists in the registry, the client permission pre-check passes (the same predicates
 * as operation commands) and `available` agrees. The server still decides.
 */
export function propertySource(
  registry: OperationRegistry,
  definitions: readonly PropertyCommand[],
): CommandSource {
  return () =>
    definitions.map((def): Command => {
      const base = {
        id: def.id,
        title: def.title,
        section: def.section,
        ...(def.keywords === undefined ? {} : { keywords: def.keywords }),
        ...(def.destructive === true ? { destructive: true } : {}),
        ...(def.shortcut === undefined ? {} : { shortcuts: shortcutsFor(def.shortcut) }),
        when: (ctx: CommandContext) => {
          const target = propertyTarget(ctx);
          if (target === null || !def.appliesTo.includes(target.kind)) return false;
          const op = registry.get(def.operation ?? DEFAULT_OPERATION);
          if (op === undefined || !permits(op, ctx, def.refs(ctx))) return false;
          const { available } = def;
          return isAvailableHere(
            available === undefined ? undefined : (_target, store) => available(target, store),
            ctx,
          );
        },
        appliesTo: (ctx: CommandContext) => {
          const target = propertyTarget(ctx);
          return target !== null && def.appliesTo.includes(target.kind);
        },
      };
      return 'picker' in def
        ? { ...base, page: (ctx) => def.picker(ctx) }
        : { ...base, run: (ctx) => def.run(ctx) };
    });
}
