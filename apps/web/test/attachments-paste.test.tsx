// @vitest-environment jsdom
// PLAN-014 S5, SPEC-014 §3.1, §3.2: pasting and dropping on the issue page. A lone URL pasted
// outside text fields opens the link form filled in (AC-22); in the title, a comment or any other
// field the paste is that field's (E23). Pasted or dropped files upload as attachments, except a
// drop in an editor, which is the editor's.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_1,
  clearToasts,
  imageRow,
  mountAttachments,
  press,
  type AttachmentWorld,
} from './attachments-harness.js';
import { around, field, focus, linkDialog, uploadRows } from './attachments-page.js';

vi.mock('../src/features/comments/editor-host.js', () => import('./comment-editor-fake.js'));

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let world: AttachmentWorld | undefined;

afterEach(async () => {
  await world?.unmount();
  world = undefined;
  clearToasts();
  vi.restoreAllMocks();
});

/** Pastes `data` on `target` as the browser does. */
async function paste(target: EventTarget, data: { text?: string; files?: File[] }): Promise<Event> {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: data.files ?? [],
      getData: (type: string) => (type === 'text/plain' ? (data.text ?? '') : ''),
    },
  });
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

describe('paste on the page (§3.1, §3.2)', () => {
  it('AC-22: a lone URL pasted outside text fields opens the link form filled in', async () => {
    world = await mountAttachments({ around });
    const event = await paste(document.body, { text: '  https://example.com/spec  ' });
    expect(event.defaultPrevented).toBe(true);
    const url = linkDialog()?.querySelector('input');
    expect(url?.value).toBe('https://example.com/spec');
  });

  it('E23: a URL pasted in a text field or an editor is left to it', async () => {
    world = await mountAttachments({ around });
    for (const label of ['Title', 'Comment']) {
      await focus(field(label));
      const event = await paste(field(label), { text: 'https://example.com/spec' });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(linkDialog()).toBeUndefined();
  });

  it('leaves a paste to an open overlay, such as the image viewer', async () => {
    world = await mountAttachments({ attachments: [imageRow(IMAGE_1)] });
    const title = [...document.querySelectorAll('[data-attachment-id] button')].find(
      (b) => b.textContent === 'screenshot.png',
    );
    await press(title);
    expect(document.querySelector('[role="dialog"] img')).not.toBeNull();
    const event = await paste(document.body, { text: 'https://example.com/spec' });
    expect(event.defaultPrevented).toBe(false);
    expect(linkDialog()).toBeUndefined();
  });

  it('ignores text that is more than one address', async () => {
    world = await mountAttachments();
    await paste(document.body, { text: 'see https://example.com/spec' });
    expect(linkDialog()).toBeUndefined();
  });

  it('pasted files upload as attachments', async () => {
    world = await mountAttachments();
    await paste(document.body, { files: [new File(['x'], 'shot.png', { type: 'image/png' })] });
    expect(uploadRows()).toHaveLength(1);
    expect(world.uploader.calls[0]?.request.purpose).toBe('attachment');
  });
});

/** Drops `files` on `target` as the browser does. */
async function drop(target: EventTarget, files: File[]): Promise<Event> {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files } });
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

describe('drop on the page (§3.1)', () => {
  it('uploads files dropped on the page, but leaves a drop in an editor to it', async () => {
    world = await mountAttachments({ around });
    const inEditor = await drop(field('Rich text'), [new File(['x'], 'a.pdf')]);
    expect(inEditor.defaultPrevented).toBe(false);
    expect(uploadRows()).toHaveLength(0);
    await drop(document.body, [new File(['x'], 'a.pdf'), new File(['y'], 'b.pdf')]);
    expect(uploadRows()).toHaveLength(2);
  });

  it('a file dropped on a plain field neither attaches nor lets the browser open it', async () => {
    world = await mountAttachments({ around });
    for (const label of ['Title', 'Comment']) {
      const event = await drop(field(label), [new File(['x'], 'a.pdf')]);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(uploadRows()).toHaveLength(0);
  });
});
