// @vitest-environment jsdom
// PLAN-014 S5, SPEC-014 §3.4, §7: the image viewer. It shows an image attachment at full size;
// `←` and `→` (the `modal` scope bindings) step through the issue's images, `Esc` closes it, and
// focus is trapped inside and returns to the row (AC-19, unit part).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_1,
  IMAGE_2,
  attachmentRow,
  clearToasts,
  imageRow,
  mountAttachments,
  press,
  settle,
  uuidOf,
  type AttachmentWorld,
} from './attachments-harness.js';
import { focus } from './attachments-page.js';
import { keydown } from './issue-fixtures.js';

vi.mock('../src/features/comments/editor-host.js', () => import('./comment-editor-fake.js'));

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let world: AttachmentWorld | undefined;

afterEach(async () => {
  await world?.unmount();
  world = undefined;
  clearToasts();
  vi.restoreAllMocks();
});

describe('the image viewer (§3.4)', () => {
  const images = [
    imageRow(IMAGE_1, { title: 'first.png', createdAt: '2026-11-01T00:00:00.000Z' }),
    imageRow(IMAGE_2, { title: 'second.png', createdAt: '2026-11-02T00:00:00.000Z' }),
    attachmentRow(uuidOf(931), { createdAt: '2026-11-03T00:00:00.000Z' }),
  ];
  const viewer = () => document.querySelector('[role="dialog"]');
  const shown = () => viewer()?.querySelector('img')?.getAttribute('alt');

  it('opens an image at full size, steps with ← and →, and Esc returns focus to the row', async () => {
    world = await mountAttachments({ attachments: images });
    const title = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-attachment-id] button'),
    ].find((b) => b.textContent === 'first.png');
    if (title === undefined) throw new Error('no image title');
    await focus(title);
    await press(title);
    expect(shown()).toBe('first.png');
    expect(viewer()?.querySelector('img')?.getAttribute('src')).toBe(
      `/files/${String(images[0]?.['fileId'])}`,
    );
    expect(viewer()?.textContent).toContain('1 of 2');
    // Focus moves into the viewer and stays there (the Dialog's trap).
    expect(viewer()?.contains(document.activeElement)).toBe(true);

    await keydown(document.activeElement ?? document.body, 'ArrowRight', { code: 'ArrowRight' });
    expect(shown()).toBe('second.png');
    // The last image: → does nothing (only images are stepped through, not the PDF).
    await keydown(document.activeElement ?? document.body, 'ArrowRight', { code: 'ArrowRight' });
    expect(shown()).toBe('second.png');
    await keydown(document.activeElement ?? document.body, 'ArrowLeft', { code: 'ArrowLeft' });
    expect(shown()).toBe('first.png');

    await keydown(document.activeElement ?? document.body, 'Escape', { code: 'Escape' });
    await settle();
    expect(viewer()).toBeNull();
    // Radix returns focus after its own deferred close (a timer): wait for it, with a deadline.
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(title);
    });
  });
});
