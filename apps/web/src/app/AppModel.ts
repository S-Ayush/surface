// What the router, the command menu and the shell share: auth, the client store once the shell
// has opened it, and live read models over it. Everything reads MobX observables, so a reaction
// (the command menu, E4) or an observing component updates when a delta lands.
import type { Actor } from '@surface/domain';
import { Team, TeamMembership, User, UserPreferences, Workspace } from '@surface/domain/model';
import {
  readPreferences,
  readSavedTheme,
  type Preferences,
  type ThemePreferenceValue,
} from '@surface/operations';
import type { SyncStore } from '@surface/sync-client';
import { observable, runInAction } from 'mobx';
import type { TeamSummary } from '../command-menu/model.js';
import type { AuthState, Session } from './auth.js';
import { StoreSequence } from './stores.js';
import { actorOf, homePath, homeTeamOf, myTeams, teamByKey } from './workspace.js';

export class AppModel {
  readonly auth: AuthState;
  /** The open store and the session (`AuthSnapshot.epoch`) it was opened for. */
  readonly #open = observable.box<{ readonly store: SyncStore; readonly epoch: number } | null>(
    null,
    { deep: false },
  );
  /** One store at a time: the next session's starts after the previous one has closed. */
  readonly stores = new StoreSequence();

  constructor(auth: AuthState) {
    this.auth = auth;
  }

  /**
   * The store the shell opened for the current session. Null as soon as the session changes:
   * until the new shell opens its own, the previous session's replica (maybe another user's) must
   * not be read, and pages must not see its rows vanish as the stores swap (SPEC-005 E5).
   */
  get store(): SyncStore | null {
    const open = this.#open.get();
    const snapshot = this.auth.snapshot;
    const current =
      snapshot.status === 'ready' && snapshot.session !== null ? snapshot.epoch : undefined;
    return open !== null && open.epoch === current ? open.store : null;
  }

  /** The shell opened `store` for the session at `epoch`. */
  openStore(store: SyncStore, epoch: number): void {
    runInAction(() => this.#open.set({ store, epoch }));
  }

  /** The shell that opened `store` closed; a newer shell's store stays. */
  closeStore(store: SyncStore): void {
    runInAction(() => {
      if (this.#open.get()?.store === store) this.#open.set(null);
    });
  }

  get session(): Session | null {
    const snapshot = this.auth.snapshot;
    return snapshot.status === 'ready' ? snapshot.session : null;
  }

  /** The store, once its replica is ready: what saving a preference needs. */
  get readyStore(): SyncStore | null {
    return this.#ready();
  }

  /** The store, once its replica is ready to read. */
  #ready(): SyncStore | null {
    const store = this.store;
    return store !== null && store.status === 'ready' ? store : null;
  }

  /** The signed-in user as the permission predicates see them (command menu pre-check). */
  actor = (): Actor | null => {
    const store = this.#ready();
    const session = this.session;
    if (store === null || session === null) return null;
    return actorOf(
      store.pool.get(User, session.userId),
      store.pool.all(Team),
      store.pool.all(TeamMembership),
    );
  };

  /** `undefined` until the store has the user's row (guards wait for it). */
  isAdmin = (): boolean | undefined => {
    const actor = this.actor();
    return actor === null ? undefined : actor.role === 'admin';
  };

  teams = (): TeamSummary[] => {
    const store = this.#ready();
    const session = this.session;
    if (store === null || session === null) return [];
    return myTeams(store.pool.all(Team), store.pool.all(TeamMembership), session.userId);
  };

  team = (key: string) => {
    const store = this.#ready();
    return store === null ? undefined : teamByKey(store.pool.all(Team), key);
  };

  workspaceName = (): string => {
    const store = this.#ready();
    return (store === null ? undefined : store.pool.all(Workspace)[0]?.name) ?? 'Surface';
  };

  /** The user's preferences (SPEC-005 §6), once the replica is ready; defaults until they set any. */
  preferences = (): Preferences | undefined => {
    const store = this.#ready();
    const session = this.session;
    if (store === null || session === null) return undefined;
    return readPreferences(store.pool.get(UserPreferences, session.userId)?.values);
  };

  /** The theme the user saved; null if they never chose one; undefined until the replica is ready. */
  savedTheme = (): ThemePreferenceValue | null | undefined => {
    const store = this.#ready();
    const session = this.session;
    if (store === null || session === null) return undefined;
    return readSavedTheme(store.pool.get(UserPreferences, session.userId)?.values);
  };

  /** Where `/` goes (SPEC-005 §3): the home team if the user can still see it, else My issues. */
  home = (): string | undefined => {
    const store = this.#ready();
    const preferences = this.preferences();
    if (store === null || preferences === undefined) return undefined;
    return homePath(preferences.homeTeamId, store.pool.all(Team));
  };

  /** The home team while the user can see it (the Preferences screen shows it); else undefined. */
  homeTeam = (): TeamSummary | undefined => {
    const store = this.#ready();
    const preferences = this.preferences();
    if (store === null || preferences === undefined) return undefined;
    const team = homeTeamOf(preferences.homeTeamId, store.pool.all(Team));
    return team && { id: team.id, key: team.key, name: team.name };
  };

  userName = (): string | undefined => {
    const store = this.#ready();
    const session = this.session;
    if (store === null || session === null) return undefined;
    return store.pool.get(User, session.userId)?.name;
  };
}
