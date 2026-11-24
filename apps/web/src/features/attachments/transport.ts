// Sending a file's bytes (SPEC-014 §3.1, §6.1; PLAN-014 S5): `POST /files/upload?purpose=…` with
// the file as the body and its name in `X-File-Name` (percent-encoded UTF-8, §4.8). Bytes never go
// through the mutation queue (§3.6), so an upload is a request the page waits on, with progress.
// `XMLHttpRequest`, because `fetch` reports no upload progress. Tests inject a fake `Uploader`
// through `UploaderContext`; nothing here runs at import time.
import { CSRF_COOKIE, CSRF_HEADER, CSRF_INVALID, SESSION_PATH } from '@surface/sync-protocol';
import { createContext, useContext } from 'react';
import { z } from 'zod';
import { cookieValue } from '../../app/http.js';
import { UNREACHABLE } from '../files/operation.js';

/** SPEC-014 §6.4, the client-side refusal (§3.6). */
export const OFFLINE_UPLOAD_MESSAGE =
  "Uploads need a connection. Try again when you're back online.";

/** The name header (`apps/server/src/files/routes.ts` `FILE_NAME_HEADER`). */
export const FILE_NAME_HEADER = 'X-File-Name';

export type UploadPurpose = 'attachment' | 'inline';

/** The upload route's `201` answer (§6.1). */
const UploadAnswerSchema = z.object({
  id: z.uuid(),
  url: z.string(),
  mimeType: z.string(),
  size: z.number().int().min(0),
  name: z.string(),
  width: z.number().int().min(0).optional(),
  height: z.number().int().min(0).optional(),
});
export type UploadAnswer = z.output<typeof UploadAnswerSchema>;

const Answer = z.object({ ok: z.literal(true), result: UploadAnswerSchema });
const Refusal = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});

export type UploadResult =
  | { readonly ok: true; readonly answer: UploadAnswer }
  | { readonly ok: false; readonly message: string; readonly aborted: boolean };

export interface UploadRequest {
  readonly file: File;
  readonly purpose: UploadPurpose;
  /** 0–1, as the bytes leave the browser. */
  readonly onProgress?: (fraction: number) => void;
  /** Aborting it cancels the upload: the result is `aborted`. */
  readonly signal?: AbortSignal;
}

export type Uploader = (request: UploadRequest) => Promise<UploadResult>;

/** The parts of a `ProgressEvent` the uploader reads. */
export type UploadProgress = Pick<ProgressEvent, 'lengthComputable' | 'loaded' | 'total'>;

/** The parts of `XMLHttpRequest` the uploader uses, so it is tested without a browser. */
export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
  readonly status: number;
  readonly responseText: string;
  readonly upload: {
    addEventListener(type: 'progress', listener: (event: UploadProgress) => void): void;
  };
  addEventListener(type: 'load' | 'error' | 'abort' | 'timeout', listener: () => void): void;
}

export interface XhrUploaderDeps {
  readonly createXhr: () => XhrLike;
  readonly cookies: () => string;
  /** Gets the session again, which sets a fresh CSRF cookie (SPEC-001 §6.1); true if it worked. */
  readonly renewSession: () => Promise<boolean>;
}

type Sent =
  | { readonly kind: 'answer'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'failed' }
  | { readonly kind: 'aborted' };

function parseBody(text: string): unknown {
  try {
    const body: unknown = JSON.parse(text);
    return body;
  } catch {
    return undefined;
  }
}

function sendOnce(deps: XhrUploaderDeps, request: UploadRequest): Promise<Sent> {
  return new Promise((resolve) => {
    if (request.signal?.aborted === true) {
      resolve({ kind: 'aborted' });
      return;
    }
    const xhr = deps.createXhr();
    xhr.open('POST', `/files/upload?purpose=${request.purpose}`);
    xhr.setRequestHeader('accept', 'application/json');
    xhr.setRequestHeader(
      'content-type',
      request.file.type === '' ? 'application/octet-stream' : request.file.type,
    );
    xhr.setRequestHeader(FILE_NAME_HEADER, encodeURIComponent(request.file.name));
    const token = cookieValue(deps.cookies(), CSRF_COOKIE);
    if (token !== undefined) xhr.setRequestHeader(CSRF_HEADER, token);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) {
        request.onProgress?.(Math.min(1, event.loaded / event.total));
      }
    });
    const onAbort = () => {
      xhr.abort();
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const done = (sent: Sent) => {
      request.signal?.removeEventListener('abort', onAbort);
      resolve(sent);
    };
    xhr.addEventListener('load', () => {
      done({ kind: 'answer', status: xhr.status, body: parseBody(xhr.responseText) });
    });
    xhr.addEventListener('error', () => {
      done({ kind: 'failed' });
    });
    xhr.addEventListener('timeout', () => {
      done({ kind: 'failed' });
    });
    xhr.addEventListener('abort', () => {
      done({ kind: 'aborted' });
    });
    xhr.send(request.file);
  });
}

const ABORTED: UploadResult = { ok: false, message: 'Upload canceled.', aborted: true };
const UNREACHED: UploadResult = { ok: false, message: UNREACHABLE, aborted: false };

/** The upload route's answer as a result: a refusal says what to do; a 5xx never shows internals. */
export function resultOf(status: number, body: unknown): UploadResult {
  if (status >= 200 && status < 300) {
    const parsed = Answer.safeParse(body);
    return parsed.success ? { ok: true, answer: parsed.data.result } : UNREACHED;
  }
  const refusal = status < 500 ? Refusal.safeParse(body) : undefined;
  return refusal?.success === true
    ? { ok: false, message: refusal.data.error.message, aborted: false }
    : UNREACHED;
}

/** The browser's uploader: CSRF token sent, and one resend after a stale-token refusal. */
export function xhrUploader(deps: XhrUploaderDeps): Uploader {
  return async (request) => {
    let sent = await sendOnce(deps, request);
    if (sent.kind === 'answer' && sent.status === 403 && csrfRefused(sent.body)) {
      if (!(await deps.renewSession())) return resultOf(sent.status, sent.body);
      sent = await sendOnce(deps, request);
    }
    if (sent.kind === 'aborted') return ABORTED;
    if (sent.kind === 'failed') return UNREACHED;
    return resultOf(sent.status, sent.body);
  };
}

function csrfRefused(body: unknown): boolean {
  const refusal = Refusal.safeParse(body);
  return refusal.success && refusal.data.error.code === CSRF_INVALID;
}

export const UploaderContext = createContext<Uploader | null>(null);

// Built on first use, so rendering in tests never touches `window`.
let browser: Uploader | undefined;
const browserUploader: Uploader = (request) => {
  browser ??= xhrUploader({
    createXhr: () => new XMLHttpRequest(),
    cookies: () => document.cookie,
    renewSession: async () => {
      try {
        const response = await window.fetch(SESSION_PATH, {
          headers: { accept: 'application/json' },
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  });
  return browser(request);
};

export function useUploader(): Uploader {
  return useContext(UploaderContext) ?? browserUploader;
}
