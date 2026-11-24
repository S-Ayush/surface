/**
 * Process lifecycle (SPEC-004 §8): readiness state, readiness checks and
 * ordered shutdown hooks.
 *
 *   starting ──markReady()──▶ ready ──beginDraining()──▶ draining
 *
 * `/readyz` is 200 only in `ready` with every check passing. Later slices
 * register checks (database reachable, migrations current) and shutdown hooks
 * (close WebSockets with 1012, stop the job worker, close the DB pool).
 */

export type LifecycleState = 'starting' | 'ready' | 'draining';

/** A readiness check returns a short status (e.g. "ok", "current") or throws. */
export type ReadinessCheck = () => Promise<string>;

/**
 * Shutdown phases, run in order:
 * - `connections`: before HTTP stops (e.g. close WebSockets with 1012).
 * - `resources`: after in-flight requests drained (job worker, DB pool).
 */
export type ShutdownPhase = 'connections' | 'resources';

export interface ReadinessReport {
  ready: boolean;
  status: LifecycleState | 'unavailable';
  checks: Record<string, string>;
}

const CHECK_TIMEOUT_MS = 2_000;

export class Lifecycle {
  #state: LifecycleState = 'starting';
  readonly #checks = new Map<string, ReadinessCheck>();
  readonly #hooks: Record<ShutdownPhase, { name: string; run: () => Promise<void> | void }[]> = {
    connections: [],
    resources: [],
  };

  get state(): LifecycleState {
    return this.#state;
  }

  /**
   * Whether startup finished (the database is migrated), even if draining has begun since.
   * Routes that touch the database check this rather than `state`: they keep working while
   * draining, but not when a shutdown began before startup finished.
   */
  get everReady(): boolean {
    return this.#everReady;
  }

  #everReady = false;

  markReady(): void {
    if (this.#state === 'starting') {
      this.#state = 'ready';
      this.#everReady = true;
    }
  }

  beginDraining(): void {
    this.#state = 'draining';
  }

  addReadinessCheck(name: string, check: ReadinessCheck): void {
    this.#checks.set(name, check);
  }

  onShutdown(phase: ShutdownPhase, name: string, run: () => Promise<void> | void): void {
    this.#hooks[phase].push({ name, run });
  }

  shutdownHooks(
    phase: ShutdownPhase,
  ): readonly { name: string; run: () => Promise<void> | void }[] {
    return this.#hooks[phase];
  }

  async readiness(): Promise<ReadinessReport> {
    const checks: Record<string, string> = {};
    if (this.#state !== 'ready') return { ready: false, status: this.#state, checks };

    let allPassing = true;
    await Promise.all(
      [...this.#checks].map(async ([name, check]) => {
        try {
          checks[name] = await withTimeout(check(), CHECK_TIMEOUT_MS);
        } catch {
          checks[name] = 'failing';
          allPassing = false;
        }
      }),
    );
    return { ready: allPassing, status: allPassing ? 'ready' : 'unavailable', checks };
  }
}

/**
 * Starts, during startup, a resource that a `resources` shutdown hook stops (the job queue). A
 * shutdown that began meanwhile ran that hook with nothing to stop yet, so the resource is
 * stopped here and nothing is returned; one that began before the start skips it.
 */
export async function startUnlessDraining<T extends { stop(): Promise<unknown> }>(
  lifecycle: Pick<Lifecycle, 'state'>,
  start: () => Promise<T>,
): Promise<T | undefined> {
  // A call each time: the state changes while `start` runs.
  const draining = () => lifecycle.state === 'draining';
  if (draining()) return undefined;
  const started = await start();
  if (!draining()) return started;
  await started.stop();
  return undefined;
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
