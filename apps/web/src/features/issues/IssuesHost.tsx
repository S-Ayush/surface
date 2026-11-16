// The composer's host (SPEC-012 §3.1, §3.2; PLAN-012 S5), mounted once in the shell
// (`SHELL_HOSTS`): it registers `issue:create` and `nav:drafts`, decides what the composer opens
// with (context, a group's `+`, a draft, a rejected create), asks "Save as draft?" on close (and
// "Replace the ENG draft?" before **Save** would overwrite another draft of the team), and
// creates the issue: toast, announcement, the team's draft cleared, and on a rejection the toast
// with **Restore in composer** (and the replace prompt, E20).
import { uuidv7 } from '@surface/domain';
import { Issue } from '@surface/domain/model';
import { issueCreate } from '@surface/operations';
import type { SyncStore } from '@surface/sync-client';
import { Button, Dialog, toast } from '@surface/ui';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { reaction } from 'mobx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import { announce } from './announcer.js';
import { Composer, TITLE_REQUIRED } from './Composer.js';
import {
  composerDescription,
  createPayload,
  createProblem,
  draftData,
  droppedNote,
  freshState,
  hasContent,
  prefillTeam,
  restoreDraft,
  sameContent,
  stateFromCreateInput,
  type Adjusted,
  type ComposerState,
  type ComposerWorld,
  type CreateInput,
} from './composer-model.js';
import { takeComposerRequest, type ComposerRequest } from './composer-request.js';
import { readComposerWorld } from './composer-world.js';
import { draftAdapterFor } from './draft-adapter.js';
import { canonicalIssuePath } from './issue-url.js';
import { routeTeamKey } from './IssueNavHost.js';

export const NO_TEAM_MESSAGE = 'Create a team first. You can do it in Settings → Teams.';
export const REPLACE_QUESTION = 'Replace what is in the composer with the rejected issue?';
const CREATE_MORE_KEY = 'surface.composer.createMore';

/** §3.2: asked when **Save** would replace another saved draft of the team. */
export const replaceDraftQuestion = (teamKey: string) => `Replace the ${teamKey} draft?`;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** "Create more" is remembered per device (§3.1 item 8); storage may be missing or throw. */
function readCreateMore(): boolean {
  try {
    return storage()?.getItem(CREATE_MORE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeCreateMore(on: boolean): void {
  try {
    storage()?.setItem(CREATE_MORE_KEY, String(on));
  } catch {
    // Not remembered on this device; the switch still works for this session.
  }
}

interface Session {
  readonly state: ComposerState;
  readonly note: string | undefined;
  /** The team whose draft this session restored (it may be a team the user can no longer see). */
  readonly draftTeamId: string | undefined;
  readonly titleError: string | undefined;
  readonly focusTitle: number;
}

const sessionOf = (adjusted: Adjusted, draftTeamId?: string): Session => ({
  state: adjusted.state,
  note: droppedNote(adjusted.dropped),
  draftTeamId,
  titleError: undefined,
  focusTitle: 0,
});

function worldOf(store: SyncStore, me: string, homeTeamId: string | null, memberTeamIds: string[]) {
  return readComposerWorld(store.pool, me, homeTeamId, memberTeamIds);
}

export function IssuesHost() {
  const app = useApp();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const [session, setSession] = useState<Session | null>(null);
  const [asking, setAsking] = useState(false);
  const [replacing, setReplacing] = useState<{
    readonly adjusted: Adjusted;
    readonly reshow: () => void;
  } | null>(null);
  /** The team whose saved draft **Save** would replace, while the replace prompt asks (§3.2). */
  const [clash, setClash] = useState<string | null>(null);
  const [createMore, setCreateMore] = useState(readCreateMore);
  // The handlers below run from commands and toasts, after renders: they read the latest session.
  const current = useRef<Session | null>(null);
  useEffect(() => {
    current.current = session;
  }, [session]);

  const open = session !== null;
  const readWorld = useCallback((): ComposerWorld | null => {
    const store = app.readyStore;
    const me = app.session?.userId;
    if (store === null || me === undefined) return null;
    return worldOf(
      store,
      me,
      app.preferences()?.homeTeamId ?? null,
      app.teams().map((t) => t.id),
    );
  }, [app]);
  // Read only while the composer is open, so deltas don't re-render a closed composer.
  const world = useObserved(useCallback(() => (open ? readWorld() : null), [open, readWorld]));

  const show = useCallback((next: Session) => {
    current.current = next;
    setSession(next);
    setAsking(false);
  }, []);
  const close = useCallback(() => {
    current.current = null;
    setSession(null);
    setAsking(false);
    setClash(null);
  }, []);

  const noTeam = useCallback(() => {
    toast({
      message: NO_TEAM_MESSAGE,
      action: {
        label: 'Open settings',
        onAction: () => {
          void navigate({ href: '/settings/teams' });
        },
      },
    });
  }, [navigate]);

  /** Opens the composer with a rejected create's input, asking first if it holds something else. */
  const restoreRejected = useCallback(
    (input: unknown, reshow: () => void) => {
      const w = readWorld();
      if (w === null) return;
      const adjusted = stateFromCreateInput(w, input);
      if (adjusted === undefined) {
        toast({ tone: 'danger', message: "That issue's team is gone, so it can't be restored." });
        return;
      }
      const now = current.current;
      if (now !== null && hasContent(now.state) && !sameContent(now.state, adjusted.state)) {
        setReplacing({ adjusted, reshow });
        return;
      }
      show(sessionOf(adjusted));
    },
    [readWorld, show],
  );

  const openFor = useCallback(
    (request: ComposerRequest | undefined) => {
      const store = app.readyStore;
      const w = readWorld();
      if (store === null || w === null) return;
      if (request?.kind === 'rejected') {
        restoreRejected(request.input, () => undefined);
        return;
      }
      const adapter = draftAdapterFor(store);
      const routeKey = routeTeamKey(pathname);
      if (request?.kind === 'comment') {
        // SPEC-013 §3.3: the route's team (the comment's issue), the body as the description, the
        // title focused. Not the team's draft: the user asked for this text.
        const team = prefillTeam(w, routeKey);
        if (team === undefined) return noTeam();
        const state = {
          ...freshState(w, team.id),
          description: composerDescription(request.description),
        };
        show(sessionOf({ state, dropped: [] }));
        return;
      }
      if (request?.kind === 'draft') {
        // E7: a draft for a team the user can no longer see opens in the default team, with a note.
        const own = w.teams.find((t) => t.id === request.teamId);
        const target = own ?? prefillTeam(w, routeKey);
        const row = adapter.composerDraft(request.teamId);
        if (target === undefined) return noTeam();
        const restored =
          row === undefined ? undefined : restoreDraft(w, row.data, target.id, own === undefined);
        show(
          restored === undefined
            ? sessionOf({ state: freshState(w, target.id), dropped: [] })
            : sessionOf(restored, request.teamId),
        );
        return;
      }
      const add = request?.kind === 'group' ? request.add : undefined;
      const team =
        add?.teamId != null ? w.teams.find((t) => t.id === add.teamId) : prefillTeam(w, routeKey);
      if (team === undefined) return noTeam();
      // A saved draft for the team is restored instead of a fresh composer (§3.2).
      const row = adapter.composerDraft(team.id);
      const restored = row === undefined ? undefined : restoreDraft(w, row.data, team.id);
      show(
        restored === undefined
          ? sessionOf({ state: freshState(w, team.id, add), dropped: [] })
          : sessionOf(restored, team.id),
      );
    },
    [app, readWorld, pathname, restoreRejected, show, noTeam],
  );

  useCommand(
    'issue:create',
    () => {
      openFor(takeComposerRequest());
    },
    // E6: nothing while the composer is open.
    { when: () => app.readyStore !== null && current.current === null },
  );
  useCommand('nav:drafts', () => {
    void navigate({ href: '/drafts' });
  });

  const create = () => {
    const store = app.readyStore;
    const now = current.current;
    if (store === null || now === null || world === null) return;
    if (createProblem(now.state) !== undefined) {
      show({ ...now, titleError: TITLE_REQUIRED, focusTitle: now.focusTitle + 1 });
      return;
    }
    const team = world.teams.find((t) => t.id === now.state.teamId);
    if (team === undefined) return;
    const id = uuidv7();
    const input = createPayload(now.state, id);
    let outcome;
    try {
      // The composer has closed by the time the server answers, so its toast reports a refusal.
      outcome = store.dispatch(issueCreate, input, { reportRejection: () => false });
    } catch (error) {
      toast({
        tone: 'danger',
        message:
          error instanceof Error ? error.message : "The issue couldn't be created. Try again.",
      });
      return;
    }
    const adapter = draftAdapterFor(store);
    adapter.discardComposer(team.id);
    if (now.draftTeamId !== undefined && now.draftTeamId !== team.id) {
      adapter.discardComposer(now.draftTeamId);
    }
    followCreate(store, id, team.key, input, outcome, restoreRejected, (href) => {
      void navigate({ href });
    });
    if (createMore) {
      show({
        state: { ...now.state, title: '', description: null },
        note: undefined,
        draftTeamId: undefined,
        titleError: undefined,
        focusTitle: now.focusTitle + 1,
      });
    } else {
      close();
    }
  };

  /** **Save**: the session's content becomes its team's draft, and the draft it came from moves. */
  const saveDraft = (now: Session) => {
    const store = app.readyStore;
    if (store !== null) {
      const adapter = draftAdapterFor(store);
      adapter.saveComposer(now.state.teamId, draftData(now.state));
      // The draft moved with the composer to another team: one draft, not two.
      if (now.draftTeamId !== undefined && now.draftTeamId !== now.state.teamId) {
        adapter.discardComposer(now.draftTeamId);
      }
    }
    close();
  };

  const store = app.readyStore;
  const clashKey = world?.teams.find((t) => t.id === clash)?.key ?? 'team';
  return (
    <>
      {session !== null && world !== null && (
        <Composer
          open
          world={world}
          state={session.state}
          onChange={(state) => {
            show({ ...session, state, titleError: undefined });
          }}
          note={session.note}
          onNote={(note) => {
            show({ ...(current.current ?? session), note });
          }}
          restored={session.draftTeamId !== undefined}
          onDiscardDraft={() => {
            if (store !== null && session.draftTeamId !== undefined) {
              draftAdapterFor(store).discardComposer(session.draftTeamId);
            }
            show({
              ...session,
              state: freshState(world, session.state.teamId),
              note: undefined,
              draftTeamId: undefined,
              focusTitle: session.focusTitle + 1,
            });
          }}
          titleError={session.titleError}
          createMore={createMore}
          onCreateMoreChange={(on) => {
            setCreateMore(on);
            writeCreateMore(on);
          }}
          onSubmit={create}
          onRequestClose={() => {
            // An empty composer closes without a prompt (§3.2).
            if (hasContent(session.state)) setAsking(true);
            else close();
          }}
          onClosed={() => undefined}
          focusTitle={session.focusTitle}
        />
      )}
      <Dialog
        open={asking}
        size="sm"
        title="Save as draft?"
        description="Keep what you wrote as this team's draft, to finish later on any device."
        // `Esc` again drops the content, like Discard (§3.2); the existing draft stays (E25).
        onOpenChange={(next) => {
          if (!next) close();
        }}
        footer={
          <>
            <Button onClick={close}>Discard</Button>
            <Button
              variant="primary"
              onClick={() => {
                const now = current.current;
                if (store === null || now === null) return close();
                const target = now.state.teamId;
                // §3.2: Save never replaces another draft of the team silently (a team change, or a
                // hidden team's draft opened in the default team, E7).
                if (
                  target !== now.draftTeamId &&
                  draftAdapterFor(store).composerDraft(target) !== undefined
                ) {
                  setAsking(false);
                  setClash(target);
                  return;
                }
                saveDraft(now);
              }}
            >
              Save
            </Button>
          </>
        }
      />
      <Dialog
        open={clash !== null}
        size="sm"
        title={replaceDraftQuestion(clashKey)}
        description="Its saved draft is deleted, and this one takes its place."
        // Cancel and `Esc` go back to the composer with nothing lost.
        onOpenChange={(next) => {
          if (!next) setClash(null);
        }}
        footer={
          <>
            <Button
              onClick={() => {
                setClash(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const now = current.current;
                setClash(null);
                if (now === null) return close();
                saveDraft(now);
              }}
            >
              Replace
            </Button>
          </>
        }
      />
      <Dialog
        open={replacing !== null}
        size="sm"
        title={REPLACE_QUESTION}
        onOpenChange={(next) => {
          if (!next) {
            replacing?.reshow();
            setReplacing(null);
          }
        }}
        footer={
          <>
            <Button
              onClick={() => {
                replacing?.reshow();
                setReplacing(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (replacing !== null) show(sessionOf(replacing.adjusted));
                setReplacing(null);
              }}
            >
              Replace
            </Button>
          </>
        }
      />
    </>
  );
}

/**
 * After `issue.create` is queued (§3.1 items 6 and 9): "Created ENG-…" with **Open**, updated in
 * place to "Created ENG-42" when the number arrives, and announced; on a rejection the toast says
 * why and offers **Restore in composer**.
 */
function followCreate(
  store: SyncStore,
  id: string,
  teamKey: string,
  input: CreateInput,
  outcome: Promise<
    | { readonly status: 'confirmed' }
    | { readonly status: 'rejected'; readonly error: { readonly message: string } }
  >,
  restore: (input: unknown, reshow: () => void) => void,
  go: (href: string) => void,
): void {
  const toastId = `issue-created-${id}`;
  const created = (number: number | null) => {
    toast({
      id: toastId,
      message: `Created ${teamKey}-${number === null ? '…' : String(number)}`,
      action: {
        label: 'Open',
        onAction: () => {
          const row = store.pool.get(Issue, id);
          go(canonicalIssuePath({ id, number: row?.number ?? null, title: input.title }, teamKey));
        },
      },
    });
  };
  created(null);
  const stop = reaction(
    () => store.pool.get(Issue, id)?.number ?? null,
    (number) => {
      if (number === null) return;
      created(number);
      announce(`Created ${teamKey}-${String(number)}`);
      stop();
    },
  );
  outcome.then(
    (result) => {
      stop();
      if (result.status !== 'rejected') return;
      const reject = () => {
        toast({
          id: toastId,
          tone: 'danger',
          message: `Couldn't create the issue: ${result.error.message}`,
          action: {
            label: 'Restore in composer',
            onAction: () => {
              restore(input, reject);
            },
          },
        });
      };
      reject();
      announce(`Couldn't create the issue: ${result.error.message}`);
    },
    () => {
      stop();
    },
  );
}
