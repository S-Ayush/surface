// What the router, the command menu and the shell share: auth, the client store once the shell
// has opened it, and live read models over it. Everything reads MobX observables, so a reaction
// (the command menu, E4) or an observing component updates when a delta lands.
import type { Actor } from '@surface/domain';
import { Team, TeamMembership, User, Workspace } from '@surface/domain/model';
import type { SyncStore } from '@surface/sync-client';
import { observable, runInAction } from 'mobx';
import type { TeamSummary } from '../command-menu/model.js';
import type { AuthState, Session } from './auth.js';
import { actorOf, myTeams, teamByKey } from './workspace.js';

export class AppModel {
  readonly auth: AuthState;
  readonly #store = observable.box<SyncStore | null>(null, { deep: false });

  constructor(auth: AuthState) {
    this.auth = auth;
  }

  /** The store, while the shell has one open for the signed-in user. */
  get store(): SyncStore | null {
    return this.#store.get();
  }

  setStore(store: SyncStore | null): void {
    runInAction(() => this.#store.set(store));
  }

  get session(): Session | null {
    const snapshot = this.auth.snapshot;
    return snapshot.status === 'ready' ? snapshot.session : null;
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

  userName = (): string | undefined => {
    const store = this.#ready();
    const session = this.session;
    if (store === null || session === null) return undefined;
    return store.pool.get(User, session.userId)?.name;
  };
}
