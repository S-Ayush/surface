// PLAN-014 S5 unit parts: the row text and link-form rules (SPEC-014 §3.2, §6.4, §7), the upload
// transport (§3.1, §6.1: CSRF, refusals, 5xx, cancel), the upload queue (progress, Cancel, Retry,
// the offline refusal §3.6, 3 at once) and the editor's inline upload (SPEC-013 §3.5, E11). No
// request leaves the test: the transport runs over a fake `XMLHttpRequest`.
import { CSRF_HEADER, CSRF_INVALID } from '@surface/sync-protocol';
import { describe, expect, it } from 'vitest';
import { editorUpload } from '../src/features/attachments/editor-upload.js';
import {
  checkLinkForm,
  formatSize,
  hostOf,
  itemsFromSummaries,
  linkOf,
  loneUrl,
  targetLabel,
} from '../src/features/attachments/model.js';
import {
  FILE_NAME_HEADER,
  OFFLINE_UPLOAD_MESSAGE,
  resultOf,
  xhrUploader,
  type UploadProgress,
  type UploadResult,
  type Uploader,
  type XhrLike,
} from '../src/features/attachments/transport.js';
import { UploadQueue } from '../src/features/attachments/useUpload.js';
import { UNREACHABLE } from '../src/features/files/operation.js';

const FILE_ID = '0192f0c1-7e5a-7b3c-9d4e-000000000951';
const PREVIEW_ID = '0192f0c1-7e5a-7b3c-9d4e-000000000952';
const file = (name = 'spec.pdf', type = 'application/pdf') =>
  new File(['12345678'], name, { type });
const stored = (name = 'spec.pdf') => ({
  ok: true as const,
  result: { id: FILE_ID, url: `/files/${FILE_ID}`, mimeType: 'application/pdf', size: 8, name },
});

describe('row text (§7)', () => {
  it('shows sizes as file managers do', () => {
    expect(formatSize(1)).toBe('1 byte');
    expect(formatSize(512)).toBe('512 bytes');
    expect(formatSize(2048)).toBe('2 KB');
    expect(formatSize(1_258_291)).toBe('1.2 MB');
    expect(formatSize(25 * 1024 * 1024)).toBe('25 MB');
  });

  it("shows a link's host without www", () => {
    expect(hostOf('https://www.figma.com/file/abc')).toBe('figma.com');
    expect(hostOf('http://10.0.0.5:8080/status')).toBe('10.0.0.5');
  });

  it('names the command target "Attachment: <title>"', () => {
    expect(targetLabel({ title: 'design.pdf' })).toBe('Attachment: design.pdf');
  });

  it("reads issue.get's summaries: file ids from their addresses, oldest first", () => {
    const base = {
      kind: 'file' as const,
      url: null,
      fileName: 'a.png',
      mimeType: 'image/png',
      size: 10,
      imageWidth: 2,
      imageHeight: 2,
      creator: { id: 'u-1', name: 'Iris West' },
    };
    const items = itemsFromSummaries([
      {
        ...base,
        id: 'b',
        title: 'Second',
        downloadUrl: `https://surface.test/files/${FILE_ID}`,
        previewUrl: `https://surface.test/files/${PREVIEW_ID}`,
        createdAt: '2026-11-02T00:00:00.000Z',
      },
      {
        ...base,
        id: 'a',
        title: 'First',
        downloadUrl: null,
        previewUrl: null,
        createdAt: '2026-11-01T00:00:00.000Z',
      },
    ]);
    expect(items.map((item) => item.title)).toEqual(['First', 'Second']);
    expect(items[1]?.fileId).toBe(FILE_ID);
    expect(items[1]?.previewUrl).toBe(`/files/${PREVIEW_ID}`);
    expect(items[1] && linkOf(items[1], 'https://surface.test')).toBe(
      `https://surface.test/files/${FILE_ID}`,
    );
  });
});

describe('the link form (§3.2, §6.4)', () => {
  it('asks for an address, then checks it as the server does', () => {
    expect(checkLinkForm('  ', '')).toEqual({
      ok: false,
      field: 'url',
      message: 'Enter a web address.',
    });
    expect(checkLinkForm('ftp://example.com', '')).toMatchObject({ ok: false, field: 'url' });
    expect(checkLinkForm(' https://example.com/a ', '  ')).toEqual({
      ok: true,
      url: 'https://example.com/a',
    });
    expect(checkLinkForm('https://example.com/a', '  Spec  ')).toEqual({
      ok: true,
      url: 'https://example.com/a',
      title: 'Spec',
    });
    expect(checkLinkForm('https://example.com/a', 'x'.repeat(256))).toMatchObject({
      ok: false,
      field: 'title',
    });
  });

  it('takes pasted text as a link only when it is one web address and nothing else (E23)', () => {
    expect(loneUrl('  https://example.com/a  ')).toBe('https://example.com/a');
    expect(loneUrl('see https://example.com/a')).toBeUndefined();
    expect(loneUrl('javascript:alert(1)')).toBeUndefined();
    expect(loneUrl('hello')).toBeUndefined();
  });
});

/** A fake XMLHttpRequest the test answers. */
class FakeXhr implements XhrLike {
  static made: FakeXhr[] = [];
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: Blob | undefined;
  aborted = false;
  status = 0;
  responseText = '';
  readonly #listeners = new Map<string, (() => void)[]>();
  readonly #progress: ((event: UploadProgress) => void)[] = [];
  readonly upload = {
    addEventListener: (_type: 'progress', listener: (event: UploadProgress) => void) => {
      this.#progress.push(listener);
    },
  };
  constructor() {
    FakeXhr.made.push(this);
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  send(body: Blob): void {
    this.body = body;
  }
  abort(): void {
    this.aborted = true;
    this.#fire('abort');
  }
  addEventListener(type: string, listener: () => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  progress(loaded: number, total: number): void {
    for (const listener of this.#progress) {
      listener({ lengthComputable: true, loaded, total });
    }
  }
  answer(status: number, body: unknown): void {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.#fire('load');
  }
  fail(): void {
    this.#fire('error');
  }
  #fire(type: string): void {
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }
}

function uploaderWith(options: { renew?: boolean; cookies?: () => string } = {}) {
  FakeXhr.made = [];
  let renewals = 0;
  const upload = xhrUploader({
    createXhr: () => new FakeXhr(),
    cookies: options.cookies ?? (() => 'surface_csrf=tok-1'),
    renewSession: () => {
      renewals += 1;
      return Promise.resolve(options.renew ?? true);
    },
  });
  return { upload, renewals: () => renewals };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('the upload transport (§3.1, §6.1)', () => {
  it('posts the bytes with the purpose, type, encoded name and CSRF token, and reports progress', async () => {
    const { upload } = uploaderWith();
    const progress: number[] = [];
    const done = upload({
      file: file('ré sumé.pdf'),
      purpose: 'inline',
      onProgress: (f) => progress.push(f),
    });
    const xhr = FakeXhr.made[0];
    expect(xhr?.method).toBe('POST');
    expect(xhr?.url).toBe('/files/upload?purpose=inline');
    expect(xhr?.headers['content-type']).toBe('application/pdf');
    expect(xhr?.headers[FILE_NAME_HEADER.toLowerCase()]).toBe('r%C3%A9%20sum%C3%A9.pdf');
    expect(xhr?.headers[CSRF_HEADER.toLowerCase()]).toBe('tok-1');
    xhr?.progress(4, 8);
    xhr?.answer(201, stored());
    expect(await done).toEqual({ ok: true, answer: stored().result });
    expect(progress).toEqual([0.5]);
  });

  it('sends a file without a type as application/octet-stream', () => {
    const { upload } = uploaderWith();
    void upload({ file: file('blob', ''), purpose: 'attachment' });
    expect(FakeXhr.made[0]?.headers['content-type']).toBe('application/octet-stream');
  });

  it('renews a stale CSRF token once and sends again', async () => {
    const { upload, renewals } = uploaderWith();
    const done = upload({ file: file(), purpose: 'attachment' });
    FakeXhr.made[0]?.answer(403, {
      ok: false,
      error: { code: CSRF_INVALID, message: 'Reload the page.', correlationId: 'c' },
    });
    await flush();
    expect(renewals()).toBe(1);
    FakeXhr.made[1]?.answer(201, stored());
    expect(await done).toMatchObject({ ok: true });
  });

  it("says the server's reason for a refusal, and never a 5xx's body", () => {
    expect(
      resultOf(413, {
        ok: false,
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Files must be 25 MB or smaller.' },
      }),
    ).toEqual({ ok: false, message: 'Files must be 25 MB or smaller.', aborted: false });
    expect(
      resultOf(500, { ok: false, error: { code: 'INTERNAL', message: 'pg: relation missing' } }),
    ).toEqual({ ok: false, message: UNREACHABLE, aborted: false });
    expect(resultOf(201, 'not json')).toEqual({ ok: false, message: UNREACHABLE, aborted: false });
  });

  it('a dropped connection is "unreachable"; an abort is a cancel', async () => {
    const { upload } = uploaderWith();
    const failed = upload({ file: file(), purpose: 'attachment' });
    FakeXhr.made[0]?.fail();
    expect(await failed).toEqual({ ok: false, message: UNREACHABLE, aborted: false });

    const controller = new AbortController();
    const canceled = upload({ file: file(), purpose: 'attachment', signal: controller.signal });
    controller.abort();
    expect(await canceled).toMatchObject({ ok: false, aborted: true });
    expect(FakeXhr.made[1]?.aborted).toBe(true);
  });
});

/** An uploader the test answers by hand. */
function handUploader() {
  const calls: { file: File; resolve: (result: UploadResult) => void; signal?: AbortSignal }[] = [];
  const uploader: Uploader = (request) =>
    new Promise((resolve) => {
      request.signal?.addEventListener('abort', () => {
        resolve({ ok: false, message: 'Upload canceled.', aborted: true });
      });
      calls.push({
        file: request.file,
        resolve,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    });
  return { uploader, calls };
}

function queueWith(online = true) {
  const { uploader, calls } = handUploader();
  const attached: string[] = [];
  const toasts: string[] = [];
  let isOnline = online;
  const queue = new UploadQueue({
    uploader,
    online: () => isOnline,
    attach: (answer) => attached.push(answer.name),
    toast: (message) => toasts.push(message),
  });
  return {
    queue,
    calls,
    attached,
    toasts,
    setOnline: (value: boolean) => {
      isOnline = value;
    },
  };
}

describe('the upload queue (§3.1, §3.6)', () => {
  it('offline, refuses with the message and queues nothing', () => {
    const q = queueWith(false);
    expect(q.queue.add([file()])).toBe(false);
    expect(q.toasts).toEqual([OFFLINE_UPLOAD_MESSAGE]);
    expect(q.queue.rows()).toEqual([]);
    expect(q.calls).toEqual([]);
  });

  it('removes the row and attaches once the bytes are stored', async () => {
    const q = queueWith();
    q.queue.add([file()]);
    expect(q.queue.rows()).toMatchObject([{ name: 'spec.pdf', state: 'uploading' }]);
    q.calls[0]?.resolve({ ok: true, answer: stored().result });
    await flush();
    expect(q.queue.rows()).toEqual([]);
    expect(q.attached).toEqual(['spec.pdf']);
  });

  it('keeps a failed row with the reason; Retry offline refuses, online sends again', async () => {
    const q = queueWith();
    q.queue.add([file()]);
    q.calls[0]?.resolve({ ok: false, message: 'Files must be 25 MB or smaller.', aborted: false });
    await flush();
    const row = q.queue.rows()[0];
    expect(row).toMatchObject({ state: 'failed', message: 'Files must be 25 MB or smaller.' });
    q.setOnline(false);
    q.queue.retry(row?.key ?? '');
    expect(q.toasts).toEqual([OFFLINE_UPLOAD_MESSAGE]);
    expect(q.calls).toHaveLength(1);
    q.setOnline(true);
    q.queue.retry(row?.key ?? '');
    expect(q.calls).toHaveLength(2);
    expect(q.queue.rows()).toMatchObject([{ state: 'uploading' }]);
  });

  it('Cancel aborts a running upload and attaches nothing; leaving the page stops the rest', async () => {
    const q = queueWith();
    q.queue.add([file('a.pdf'), file('b.pdf')]);
    q.queue.cancel(q.queue.rows()[0]?.key ?? '');
    await flush();
    expect(q.calls[0]?.signal?.aborted).toBe(true);
    expect(q.queue.rows().map((row) => row.name)).toEqual(['b.pdf']);
    q.queue.stop();
    await flush();
    expect(q.calls[1]?.signal?.aborted).toBe(true);
    expect(q.attached).toEqual([]);
  });
});

describe("the editor's inline upload (SPEC-013 §3.5, SPEC-014 §3.3)", () => {
  it('uploads with purpose=inline and inserts /files/<id>: images as images, others as files', async () => {
    const purposes: string[] = [];
    const uploader: Uploader = (request) => {
      purposes.push(request.purpose);
      return Promise.resolve({
        ok: true,
        answer: { ...stored(request.file.name).result, mimeType: request.file.type },
      });
    };
    const upload = editorUpload(uploader, () => true);
    expect(await upload(file('shot.png', 'image/png'))).toEqual({
      src: `/files/${FILE_ID}`,
      name: 'shot.png',
      kind: 'image',
    });
    expect(await upload(file('shot.svg', 'image/svg+xml'))).toMatchObject({ kind: 'file' });
    expect(purposes).toEqual(['inline', 'inline']);
  });

  it('offline, inserts nothing and says why (E11); a refusal says the reason', async () => {
    let asked = false;
    const uploader: Uploader = () => {
      asked = true;
      return Promise.resolve({
        ok: false,
        message: 'Files must be 25 MB or smaller.',
        aborted: false,
      });
    };
    await expect(editorUpload(uploader, () => false)(file())).rejects.toThrow(
      OFFLINE_UPLOAD_MESSAGE,
    );
    expect(asked).toBe(false);
    await expect(editorUpload(uploader, () => true)(file())).rejects.toThrow(
      'Files must be 25 MB or smaller.',
    );
  });
});
