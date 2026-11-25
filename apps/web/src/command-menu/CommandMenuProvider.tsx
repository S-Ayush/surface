// Mounts the command menu (SPEC-005 §4) once, inside <ShortcutProvider>: `Mod+K` toggles it and
// `O T` opens it on the teams page. The shell (PLAN-005 S4) passes the signed-in actor, the store,
// navigation and the live teams; until then the menu offers the app's own commands.
import type { Actor } from '@surface/domain';
import { registry as defaultRegistry, type OperationRegistry } from '@surface/operations';
import type { SyncStore } from '@surface/sync-client';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useCommand, useCommandRegistry } from '../shortcuts/ShortcutProvider.js';
import { CommandMenu, PERF } from './CommandMenu.js';
import { TargetContext, TargetStore, useCurrentTarget } from './context.js';
import { Frecency } from './frecency.js';
import type { CommandContext, CommandSource, CommandTarget, TeamSummary } from './model.js';
import { appSource } from './sources/app.js';
import { OPEN_TEAM, navigationSource, teamsPage } from './sources/navigation.js';
import { OPERATION_COMMANDS, PROPERTY_COMMANDS } from '../features/commands.js';
import { pickerRequests, type PickerRequest } from '../features/issues/pickers/picker-request.js';
import { operationSource, type OperationCommand } from './sources/operations.js';
import { propertySource, type PropertyCommand } from './sources/properties.js';
import { collect, isOffered } from './ranking.js';

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
  properties?: readonly PropertyCommand[];
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

/**
 * `page`: opened on a page ("Open team…"). `request`: a keyboard property request the menu adopted
 * (command-menu.md §3.5); `released` once the user went back to the home page, which means the row
 * no longer waits for focus when the menu closes.
 */
type OpenState =
  | { readonly page?: 'teams'; readonly request?: undefined }
  | { readonly request: PickerRequest; readonly released: boolean }
  | null;

/** The issue a request acts on as the menu's target, whatever was focused when the key went down. */
const requestTarget = (request: PickerRequest, current: CommandTarget): CommandTarget =>
  current.kind === 'issue' && current.ids[0] === request.issueId
    ? current
    : { kind: 'issue', ids: [request.issueId], label: 'Issue' };

function MenuHost({
  actor = NO_ACTOR,
  store = null,
  navigate,
  teams = NO_TEAMS,
  route,
  registry = defaultRegistry,
  implementations = OPERATION_COMMANDS,
  properties = PROPERTY_COMMANDS,
}: Omit<CommandMenuProviderProps, 'children'>) {
  const commands = useCommandRegistry();
  const target = useCurrentTarget();
  const [open, setOpen] = useState<OpenState>(null);
  // A property key opens its picker as a page of this menu (command-menu.md §3.5, PLAN-016 D-e).
  const picked = useSyncExternalStore(
    pickerRequests.subscribe,
    pickerRequests.snapshot,
    pickerRequests.snapshot,
  );
  const request = picked?.frame === 'menu' ? picked : undefined;
  const adopted = open?.request;
  // A new key per adoption, so a second request while the menu is open shows its own page.
  const [adoptions, setAdoptions] = useState(0);

  const sources = useMemo<readonly CommandSource[]>(
    () => [
      operationSource(registry, commands, implementations),
      propertySource(registry, properties),
      navigationSource,
      appSource(commands),
    ],
    [registry, commands, implementations, properties],
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
  const propertyPage = (picker: PickerRequest, ctx: CommandContext) => {
    const id = `prop:issue.${picker.kind}`;
    const command = collect(sources, ctx).find((c) => c.id === id);
    return command?.page !== undefined && isOffered(command, ctx)
      ? { command, page: command.page(ctx) }
      : undefined;
  };

  // The menu takes a keyboard request over: from then on it owns it, so a popover opened later is
  // independent of it. A request the menu has no page for is dropped, not shown as the home page.
  useEffect(() => {
    if (request === undefined) return;
    if (propertyPage(request, context(requestTarget(request, target))) === undefined) {
      pickerRequests.close();
      return;
    }
    const taken = pickerRequests.release();
    if (taken === undefined) return;
    if (open?.request !== undefined && !open.released) open.request.onClosed?.();
    // A hand-over from an external store (the request), not state derived from props.
    /* eslint-disable react-hooks/set-state-in-effect */
    setAdoptions((count) => count + 1);
    setOpen({ request: taken, released: false });
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- adopts once per request
  }, [request]);

  // Esc reaches both the dialog and the picker, so a close can arrive twice: tell the request once.
  const told = useRef<PickerRequest | null>(null);
  const finish = () => {
    // The row takes focus back (the menu's own early return does it too, this tells the list).
    if (open?.request !== undefined && !open.released && told.current !== open.request) {
      told.current = open.request;
      open.request.onClosed?.();
    }
    setOpen(null);
  };
  // Mod+K opens the menu, or closes it if it is already open (command-menu.md §4).
  useCommand('ui:command-menu', () => {
    if (open === null) show({});
    else finish();
  });
  useCommand('nav:open-team', () => show({ page: 'teams' }), {
    when: () => navigate !== undefined,
  });

  const menuTarget = adopted === undefined ? target : requestTarget(adopted, target);

  return (
    <CommandMenu
      key={adoptions}
      open={open !== null}
      onClose={finish}
      onPageBack={() => {
        setOpen((current) =>
          current?.request === undefined ? current : { ...current, released: true },
        );
      }}
      sources={sources}
      context={context}
      target={menuTarget}
      frecency={frecency}
      initialPage={
        adopted !== undefined
          ? (ctx) => propertyPage(adopted, ctx)
          : open?.page === 'teams'
            ? (ctx) => ({ command: OPEN_TEAM, page: teamsPage(ctx) })
            : undefined
      }
    />
  );
}
