// Upload progress on the issue page (SPEC-014 §3.1, §3.6, §7; PLAN-014 S5). Each picked, pasted or
// dropped file gets a progress row with its name and percentage, **Cancel** while it runs, and an
// inline error with **Retry** when it fails. The rows are page state, never store state. When an
// upload finishes, its row goes and `attach` dispatches `attachment.createFile`, whose optimistic
// row takes its place. Offline nothing starts: "Uploads need a connection…" (§3.6).
//
// At most 3 uploads run at once, the server's per-user limit (§4.6); the others wait their turn.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { OFFLINE_UPLOAD_MESSAGE, type UploadAnswer, type Uploader } from './transport.js';

/** The server's "uploads at once" limit (SPEC-014 §4.6, `MAX_CONCURRENT_UPLOADS`). */
export const PARALLEL_UPLOADS = 3;

export interface UploadRow {
  readonly key: string;
  readonly name: string;
  /** 0–1. */
  readonly progress: number;
  readonly state: 'waiting' | 'uploading' | 'failed';
  /** Why it failed, in the server's words (`failed` only). */
  readonly message?: string;
}

export interface UploadQueueDeps {
  readonly uploader: Uploader;
  readonly online: () => boolean;
  /** A finished upload: its row is already gone. */
  readonly attach: (answer: UploadAnswer) => void;
  readonly toast: (message: string) => void;
  readonly parallel?: number;
}

interface Job {
  readonly key: string;
  readonly file: File;
  progress: number;
  state: UploadRow['state'];
  message?: string;
  abort?: AbortController;
}

/** The progress rows of one page, and the uploads behind them. Framework-free, for tests. */
export class UploadQueue {
  #deps: UploadQueueDeps;
  #jobs: Job[] = [];
  #rows: readonly UploadRow[] = [];
  #seq = 0;
  /** Set by `stop()` (the page closed): nothing new starts until the next `add`. */
  #stopped = false;
  readonly #listeners = new Set<() => void>();

  constructor(deps: UploadQueueDeps) {
    this.#deps = deps;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  rows = (): readonly UploadRow[] => this.#rows;

  /** The page's latest callbacks (a render may make new ones); running uploads use them too. */
  setDeps(deps: UploadQueueDeps): void {
    this.#deps = deps;
  }

  /** Starts uploading `files` (§3.1). Offline: the toast, and nothing starts. False then. */
  add(files: readonly File[]): boolean {
    if (files.length === 0) return true;
    if (!this.#deps.online()) {
      this.#deps.toast(OFFLINE_UPLOAD_MESSAGE);
      return false;
    }
    // A StrictMode remount stops the queue and then uses it again.
    this.#stopped = false;
    for (const file of files) {
      this.#seq += 1;
      this.#jobs.push({ key: `upload-${String(this.#seq)}`, file, progress: 0, state: 'waiting' });
    }
    this.#pump();
    return true;
  }

  /** **Cancel**: stops a running upload, or drops a waiting or failed row. */
  cancel(key: string): void {
    const job = this.#jobs.find((candidate) => candidate.key === key);
    if (job === undefined) return;
    if (job.state === 'uploading') {
      job.abort?.abort();
      return;
    }
    this.#remove(job);
  }

  /** **Retry** a failed upload. Offline: the toast, and the row stays failed. */
  retry(key: string): void {
    const job = this.#jobs.find((candidate) => candidate.key === key);
    if (job?.state !== 'failed') return;
    if (!this.#deps.online()) {
      this.#deps.toast(OFFLINE_UPLOAD_MESSAGE);
      return;
    }
    job.state = 'waiting';
    job.progress = 0;
    delete job.message;
    this.#stopped = false;
    this.#pump();
  }

  /**
   * The page closed: running uploads stop and waiting ones are dropped, so nothing attaches to an
   * issue the person left. The next `add` uses the queue again (StrictMode remounts).
   */
  stop(): void {
    this.#stopped = true;
    const running = this.#jobs.filter((job) => job.state === 'uploading');
    this.#jobs = running;
    for (const job of running) job.abort?.abort();
    this.#emit();
  }

  #pump(): void {
    if (this.#stopped) {
      this.#emit();
      return;
    }
    const limit = this.#deps.parallel ?? PARALLEL_UPLOADS;
    let running = this.#jobs.filter((job) => job.state === 'uploading').length;
    for (const job of this.#jobs) {
      if (running >= limit) break;
      if (job.state !== 'waiting') continue;
      running += 1;
      void this.#start(job);
    }
    this.#emit();
  }

  async #start(job: Job): Promise<void> {
    const abort = new AbortController();
    job.abort = abort;
    job.state = 'uploading';
    const result = await this.#deps.uploader({
      file: job.file,
      purpose: 'attachment',
      signal: abort.signal,
      onProgress: (fraction) => {
        job.progress = fraction;
        this.#emit();
      },
    });
    delete job.abort;
    if (result.ok) {
      // The progress row leaves as the optimistic row comes (§3.1 step 3); after `stop()` the
      // page is gone and nothing attaches.
      this.#remove(job, false);
      if (!this.#stopped) this.#deps.attach(result.answer);
    } else if (result.aborted) {
      this.#remove(job, false);
    } else {
      job.state = 'failed';
      job.message = result.message;
    }
    this.#pump();
  }

  #remove(job: Job, emit = true): void {
    this.#jobs = this.#jobs.filter((other) => other !== job);
    if (emit) this.#emit();
  }

  #emit(): void {
    this.#rows = this.#jobs.map((job) => ({
      key: job.key,
      name: job.file.name === '' ? 'file' : job.file.name,
      progress: job.progress,
      state: job.state,
      ...(job.message === undefined ? {} : { message: job.message }),
    }));
    for (const listener of this.#listeners) listener();
  }
}

/** One `UploadQueue` per mounted page; running uploads stop when it unmounts. */
export function useUpload(deps: UploadQueueDeps): {
  readonly queue: UploadQueue;
  readonly rows: readonly UploadRow[];
} {
  const [queue] = useState(() => new UploadQueue(deps));
  useEffect(() => {
    queue.setDeps(deps);
  });
  useEffect(
    () => () => {
      queue.stop();
    },
    [queue],
  );
  const rows = useSyncExternalStore(queue.subscribe, queue.rows, queue.rows);
  return { queue, rows };
}
