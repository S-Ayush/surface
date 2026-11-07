// Mounts the command menu (SPEC-005 §4) once, inside <ShortcutProvider>: `Mod+K` toggles it and
// `O T` opens it on the teams page. The shell (PLAN-005 S4) passes the signed-in actor, the store,
// navigation and the live teams; until then the menu offers the app's own commands.
import type { Actor } from '@surface/domain';
import { registry as defaultRegistry, type OperationRegistry } from '@surface/operations';
import type { SyncStore } from '@surface/sync-client';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useCommand, useCommandRegistry } from '../shortcuts/ShortcutProvider.js';
import { CommandMenu, PERF } from './CommandMenu.js';
import { TargetContext, TargetStore, useCurrentTarget } from './context.js';
import { Frecency } from './frecency.js';
import type { CommandContext, CommandSource, CommandTarget, TeamSummary } from './model.js';
import { appSource } from './sources/app.js';
import { OPEN_TEAM, navigationSource, teamsPage } from './sources/navigation.js';
import { OPERATION_COMMANDS } from '../features/commands.js';
import { operationSource, type OperationCommand } from './sources/operations.js';

export type CommandMenuProviderProps = {
  children: ReactNode;
  /** The signed-in user. Read on every evaluation, so a role change applies at once (E4). */
  actor?: () => Actor | null;
  store?: SyncStore | null;
  navigate?: (path: string) => void;
  /** Live teams in sidebar order (from the store, once the Team model exists). */
  teams?: () => readonly TeamSummary[];
  route?: () => string;
  registry?: OperationRegistry;
  implementations?: Readonly<Record<string, OperationCommand>>;
};

const NO_TEAMS = (): readonly TeamSummary[] => [];
const NO_ACTOR = (): Actor | null => null;

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function CommandMenuProvider({ children, ...props }: CommandMenuProviderProps) {
  const [targets] = useState(() => new TargetStore());
  return (
    <TargetContext value={targets}>
      {children}
      <MenuHost {...props} />
    </TargetContext>
  );
}

type OpenState = { readonly page?: 'teams' } | null;

function MenuHost({
  actor = NO_ACTOR,
  store = null,
  navigate,
  teams = NO_TEAMS,
  route,
  registry = defaultRegistry,
  implementations = OPERATION_COMMANDS,
}: Omit<CommandMenuProviderProps, 'children'>) {
  const commands = useCommandRegistry();
  const target = useCurrentTarget();
  const [open, setOpen] = useState<OpenState>(null);

  const sources = useMemo<readonly CommandSource[]>(
    () => [
      operationSource(registry, commands, implementations),
      navigationSource,
      appSource(commands),
    ],
    [registry, commands, implementations],
  );
  const context = useCallback(
    (current: CommandTarget): CommandContext => ({
      route: route?.() ?? window.location.pathname,
      target: current,
      actor: actor(),
      store,
      ...(navigate ? { navigate } : {}),
      teams,
    }),
    [actor, store, navigate, teams, route],
  );
  // Read on each render (the menu opening is one), so a new sign-in gets its own history.
  const userId = actor()?.userId ?? null;
  const frecency = useMemo(() => new Frecency({ storage: localStorageOrNull(), userId }), [userId]);

  const show = (next: OpenState) => {
    performance.mark(PERF.openStart);
    setOpen(next);
  };
  // Mod+K opens the menu, or closes it if it is already open (command-menu.md §4).
  useCommand('ui:command-menu', () => {
    if (open === null) show({});
    else setOpen(null);
  });
  useCommand('nav:open-team', () => show({ page: 'teams' }), {
    when: () => navigate !== undefined,
  });

  return (
    <CommandMenu
      open={open !== null}
      onClose={() => setOpen(null)}
      sources={sources}
      context={context}
      target={target}
      frecency={frecency}
      initialPage={
        open?.page === 'teams' ? (ctx) => ({ command: OPEN_TEAM, page: teamsPage(ctx) }) : undefined
      }
    />
  );
}
