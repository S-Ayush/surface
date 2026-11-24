// @vitest-environment jsdom
// PLAN-014 S5, SPEC-014 §3.1, §3.4–§3.7, §7: the Attachments section on the issue page, against an
// in-memory replica running the operations' real `optimistic` (`attachments-harness.tsx`) and a
// fake uploader. Covers AC-19 (unit parts: rows, progress with Cancel and Retry, the offline
// refusal, Remove with Undo, rename, the link form), E1 (rollback with the reason) and E8 (Undo
// re-creates a file on the same, detached file).
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FILE_1,
  IRIS,
  IMAGE_1,
  LINK_1,
  attachmentRow,
  clearToasts,
  imageRow,
  linkRow,
  mountAttachments,
  openRowMenu,
  pickRowMenu,
  press,
  settle,
  toastAction,
  toasts,
  uuidOf,
  type AttachmentWorld,
} from './attachments-harness.js';
import { ISSUE_A, issueRow, setValue } from './issue-fixtures.js';
import { OFFLINE_UPLOAD_MESSAGE } from '../src/features/attachments/transport.js';
import { REMOVED_MESSAGE } from '../src/features/attachments/actions.js';
import { runInAction } from 'mobx';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let world: AttachmentWorld | undefined;

afterEach(async () => {
  await world?.unmount();
  world = undefined;
  clearToasts();
});

async function mount(options: Parameters<typeof mountAttachments>[0] = {}) {
  world = await mountAttachments(options);
  return world;
}

const section = () => document.querySelector('section[aria-label="Attachments"]');
const rowTitles = () =>
  [...document.querySelectorAll('[data-attachment-id]')].map(
    // The title is the first thing in the row's text column (after the thumbnail).
    (row) => row.querySelector(':scope > div > :first-child')?.textContent ?? '',
  );
const uploadRows = () => [...document.querySelectorAll('[data-testid="upload-row"]')];
const fileInput = () => {
  const input = document.querySelector('[data-testid="attachment-file-input"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('no file input');
  return input;
};
const button = (label: string) => document.querySelector(`button[aria-label="${label}"]`);

/** Chooses files in the hidden picker, as the browser does after "Attach file". */
async function choose(...files: File[]): Promise<void> {
  const input = fileInput();
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

/** A client-generated UUIDv7 id (SPEC-003 §8). */
const NEW_ID: unknown = expect.stringMatching(/^[0-9a-f-]{36}$/);

const pdf = (name = 'spec.pdf') => new File(['%PDF-1.7'], name, { type: 'application/pdf' });

describe('rows (SPEC-014 §7)', () => {
  it('shows each attachment oldest first with its size or host, creator and time', async () => {
    await mount({
      attachments: [
        linkRow(LINK_1, { createdAt: new Date(Date.now() - 3_600_000).toISOString() }),
        attachmentRow(FILE_1, { createdAt: new Date(Date.now() - 7_200_000).toISOString() }),
      ],
    });
    expect(rowTitles()).toEqual(['design.pdf', 'Login flow']);
    const [file, link] = [...document.querySelectorAll('[data-attachment-id]')];
    expect(file?.textContent).toContain('1.2 MB');
    expect(file?.textContent).toContain('Iris');
    expect(link?.textContent).toContain('figma.com');
  });

  it('opens a link in a new tab without giving it the page (noopener noreferrer, D10, E12)', async () => {
    await mount({ attachments: [linkRow(LINK_1)] });
    const anchor = document.querySelector(`[data-attachment-id="${LINK_1}"] a`);
    expect(anchor?.getAttribute('href')).toBe('https://www.figma.com/file/abc123/Login-flow');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('downloads a file with its name and shows a preview, once made, as the thumbnail', async () => {
    const preview = uuidOf(777);
    await mount({
      attachments: [attachmentRow(FILE_1), imageRow(IMAGE_1, { previewFileId: preview })],
    });
    const download = document.querySelector(`[data-attachment-id="${FILE_1}"] a[download]`);
    expect(download?.getAttribute('href')).toMatch(/^\/files\/[0-9a-f-]{36}\?download=1$/);
    const thumb = document.querySelector(`[data-attachment-id="${IMAGE_1}"] img`);
    expect(thumb?.getAttribute('src')).toBe(`/files/${preview}`);
    // An image without a preview yet shows its type icon, not the original.
    expect(document.querySelector(`[data-attachment-id="${FILE_1}"] img`)).toBeNull();
  });

  it('offers Open, Download, Copy link, Rename and Remove in the row menu', async () => {
    await mount({ attachments: [attachmentRow(FILE_1)] });
    expect(await openRowMenu('design.pdf')).toEqual([
      'Open',
      'Download',
      'Copy link',
      'Rename…',
      'Remove',
    ]);
  });

  it('makes a focused row the command target, with the chip "Attachment: <title>"', async () => {
    const w = await mount({ attachments: [attachmentRow(FILE_1)] });
    const title = document.querySelector<HTMLElement>(`[data-attachment-id="${FILE_1}"] a`);
    await act(async () => {
      title?.focus();
      await Promise.resolve();
    });
    expect(w.targets.current()).toEqual({
      kind: 'attachment',
      ids: [attachmentRow(FILE_1)['id']],
      label: 'Attachment: design.pdf',
    });
    expect(w.registry?.isAvailable('attachment:rename')).toBe(true);
    expect(w.registry?.isAvailable('attachment:remove')).toBe(true);
  });
});

describe('uploading (§3.1)', () => {
  it('shows a progress row with the name and percentage, then the optimistic row replaces it', async () => {
    const w = await mount();
    await choose(pdf());
    expect(uploadRows()).toHaveLength(1);
    expect(uploadRows()[0]?.textContent).toContain('spec.pdf');
    await act(async () => {
      w.uploader.calls[0]?.request.onProgress?.(0.4);
      await Promise.resolve();
    });
    expect(uploadRows()[0]?.textContent).toContain('40%');
    expect(w.uploader.calls[0]?.request.purpose).toBe('attachment');

    const fileId = w.uploader.finish(0);
    await settle();
    expect(uploadRows()).toHaveLength(0);
    expect(rowTitles()).toEqual(['spec.pdf']);
    // The upload's answer goes along so the row shows at once (D29).
    expect(w.server.of('attachment.createFile')).toEqual([
      {
        id: NEW_ID,
        issue: ISSUE_A,
        file: fileId,
        upload: { name: 'spec.pdf', mimeType: 'application/pdf', size: 8 },
      },
    ]);
  });

  it('Cancel stops the upload: the row goes and nothing is attached', async () => {
    const w = await mount();
    await choose(pdf());
    await press(button('Cancel spec.pdf'));
    await settle();
    expect(uploadRows()).toHaveLength(0);
    expect(w.uploader.calls[0]?.request.signal?.aborted).toBe(true);
    expect(w.server.dispatched).toEqual([]);
  });

  it('a failed upload shows the reason inline, and Retry sends it again', async () => {
    const w = await mount();
    await choose(pdf());
    w.uploader.fail(0, 'Files must be 25 MB or smaller.');
    await settle();
    expect(uploadRows()[0]?.querySelector('[role="alert"]')?.textContent).toBe(
      'Files must be 25 MB or smaller.',
    );
    await press(button('Retry spec.pdf'));
    expect(w.uploader.calls).toHaveLength(2);
    w.uploader.finish(1);
    await settle();
    expect(uploadRows()).toHaveLength(0);
    expect(w.server.of('attachment.createFile')).toHaveLength(1);
  });

  it('runs at most 3 uploads at once; the next starts when one finishes', async () => {
    const w = await mount();
    await choose(pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf'), pdf('d.pdf'));
    expect(w.uploader.calls).toHaveLength(3);
    expect(uploadRows()[3]?.textContent).toContain('Waiting…');
    w.uploader.finish(0);
    await settle();
    expect(w.uploader.calls).toHaveLength(4);
    expect(w.uploader.calls[3]?.request.file.name).toBe('d.pdf');
  });

  it('offline, Attach file says uploads need a connection and starts nothing (§3.6)', async () => {
    const w = await mount();
    runInAction(() => w.server.connection.set('offline'));
    await press(button('Attach file'));
    expect(toasts()).toContain(OFFLINE_UPLOAD_MESSAGE);
    await choose(pdf());
    expect(w.uploader.calls).toHaveLength(0);
    expect(uploadRows()).toHaveLength(0);
  });

  it('E1: a refused attach rolls the row back and toasts the reason', async () => {
    const w = await mount();
    w.server.refusals.set('attachment.createFile', 'ENG-42 is archived. Restore it to edit it.');
    w.server.holding = true;
    await choose(pdf());
    w.uploader.finish(0);
    await settle();
    expect(rowTitles()).toEqual(['spec.pdf']);
    w.server.release();
    await settle();
    expect(rowTitles()).toEqual([]);
    expect(toasts()).toContain('ENG-42 is archived. Restore it to edit it.');
  });
});

describe('Remove with Undo (§3.5, D8, E8)', () => {
  it('removes at once, and Undo attaches the same file again with its title', async () => {
    const row = attachmentRow(FILE_1, { title: 'Design v2', imageWidth: null });
    const w = await mount({ attachments: [row] });
    await pickRowMenu('Design v2', 'Remove');
    await settle();
    expect(rowTitles()).toEqual([]);
    expect(w.server.of('attachment.delete')).toEqual([{ attachment: FILE_1 }]);
    expect(toasts()).toContain(REMOVED_MESSAGE);

    await act(async () => {
      toastAction(REMOVED_MESSAGE);
      await Promise.resolve();
    });
    await settle();
    expect(w.server.of('attachment.createFile')).toEqual([
      {
        id: NEW_ID,
        issue: ISSUE_A,
        file: row['fileId'],
        title: 'Design v2',
        upload: { name: 'design.pdf', mimeType: 'application/pdf', size: 1_258_291 },
      },
    ]);
    expect(rowTitles()).toEqual(['Design v2']);
  });

  it('Undo of a link links the same address with the same title', async () => {
    const w = await mount({ attachments: [linkRow(LINK_1)] });
    await pickRowMenu('Login flow', 'Remove');
    await act(async () => {
      toastAction(REMOVED_MESSAGE);
      await Promise.resolve();
    });
    await settle();
    expect(w.server.of('attachment.createLink')).toEqual([
      {
        id: NEW_ID,
        issue: ISSUE_A,
        url: 'https://www.figma.com/file/abc123/Login-flow',
        title: 'Login flow',
      },
    ]);
    expect(rowTitles()).toEqual(['Login flow']);
  });

  it('a refused remove brings the row back and says why', async () => {
    const w = await mount({ attachments: [attachmentRow(FILE_1)] });
    w.server.refusals.set('attachment.delete', 'ENG-42 was deleted. Restore it to edit it.');
    await pickRowMenu('design.pdf', 'Remove');
    await settle();
    expect(rowTitles()).toEqual(['design.pdf']);
    expect(toasts()).toContain('ENG-42 was deleted. Restore it to edit it.');
  });
});

describe('rename and the link form', () => {
  it('Rename… sends the new title, trimmed', async () => {
    const w = await mount({ attachments: [attachmentRow(FILE_1)] });
    await pickRowMenu('design.pdf', 'Rename…');
    const field = document.querySelector<HTMLInputElement>('[role="dialog"] input');
    if (field === null) throw new Error('no title field');
    await setValue(field, '  Final design  ');
    await press(
      [...document.querySelectorAll('[role="dialog"] button')].find(
        (b) => b.textContent === 'Rename',
      ),
    );
    await settle();
    expect(w.server.of('attachment.update')).toEqual([
      { attachment: FILE_1, title: 'Final design' },
    ]);
    expect(rowTitles()).toEqual(['Final design']);
  });

  it('checks the address like the server and links it; the page is never fetched', async () => {
    const w = await mount();
    await press(button('Link any URL to issue'));
    const [url, title] = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')];
    if (url === undefined || title === undefined) throw new Error('no fields');
    const submit = () =>
      press(
        [...document.querySelectorAll('[role="dialog"] button')].find(
          (b) => b.textContent === 'Add link',
        ),
      );
    await setValue(url, 'javascript:alert(1)');
    await submit();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Use a web address that starts with https:// or http://.',
    );
    await setValue(url, 'https://user:pw@example.com/x');
    await submit();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Web addresses can't include a user name or password.",
    );
    expect(w.server.dispatched).toEqual([]);

    await setValue(url, 'http://10.0.0.5/status');
    await submit();
    await settle();
    expect(w.server.of('attachment.createLink')).toEqual([
      {
        id: NEW_ID,
        issue: ISSUE_A,
        url: 'http://10.0.0.5/status',
      },
    ]);
    expect(rowTitles()).toEqual(['10.0.0.5/status']);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('links queue while offline (§3.6): only uploads need a connection', async () => {
    const w = await mount();
    runInAction(() => w.server.connection.set('offline'));
    await press(button('Link any URL to issue'));
    const url = document.querySelector<HTMLInputElement>('[role="dialog"] input');
    if (url === null) throw new Error('no field');
    await setValue(url, 'https://example.com/a');
    await press(
      [...document.querySelectorAll('[role="dialog"] button')].find(
        (b) => b.textContent === 'Add link',
      ),
    );
    await settle();
    expect(w.server.of('attachment.createLink')).toHaveLength(1);
    expect(toasts()).not.toContain(OFFLINE_UPLOAD_MESSAGE);
  });
});

describe('read-only (archived, deleted: SPEC-014 §3.7, SPEC-012 §3.4 item 8)', () => {
  const summary = {
    id: FILE_1,
    kind: 'file' as const,
    title: 'design.pdf',
    url: null,
    fileName: 'design.pdf',
    mimeType: 'application/pdf',
    size: 2048,
    imageWidth: null,
    imageHeight: null,
    downloadUrl: `http://surface.test/files/${uuidOf(1401)}`,
    previewUrl: null,
    createdAt: new Date().toISOString(),
    creator: { id: IRIS, name: 'Iris West' },
  };

  it("shows issue.get's attachments with Open, Download and Copy link only", async () => {
    const w = await mount({
      issue: issueRow(ISSUE_A, 42, { archivedAt: new Date().toISOString() }),
      server: { issueId: ISSUE_A, state: 'ready', rows: {}, attachments: [summary] },
    });
    expect(rowTitles()).toEqual(['design.pdf']);
    expect(section()?.textContent).toContain('2 KB');
    expect(button('Attach file')).toBeNull();
    expect(await openRowMenu('design.pdf')).toEqual(['Open', 'Download', 'Copy link']);
    expect(
      document.querySelector(`[data-attachment-id="${FILE_1}"] a[download]`)?.getAttribute('href'),
    ).toBe(`/files/${uuidOf(1401)}?download=1`);
    expect(w.registry?.isAvailable('issue-page:attach-file')).toBe(false);
    expect(w.registry?.isAvailable('issue-page:link-url')).toBe(false);
  });

  it('shows nothing when a read-only issue has no attachments', async () => {
    await mount({ server: { issueId: ISSUE_A, state: 'ready', rows: {}, attachments: [] } });
    expect(section()).toBeNull();
  });
});
