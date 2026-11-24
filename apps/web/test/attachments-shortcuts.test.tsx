// @vitest-environment jsdom
// PLAN-014 S5, SPEC-012 §3.6, D31; SPEC-014 §3.2, §3.3: the attachment keys through the real
// shortcut engine with a platform flag. `Mod+Shift+U` attaches on every platform, even while typing,
// and inserts inline when an editor has focus; `Ctrl+L` is literal Control on macOS only. A fake
// network that fails on any request proves a link is never fetched or unfurled (AC-23, D9, D10).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearToasts,
  mountAttachments,
  press,
  settle,
  type AttachmentWorld,
} from './attachments-harness.js';
import {
  around,
  countFilePicker,
  field,
  focus,
  linkDialog,
  modShiftU,
} from './attachments-page.js';
import { editorUploads } from './comment-editor-fake.js';
import { keydown, setValue } from './issue-fixtures.js';

vi.mock('../src/features/comments/editor-host.js', () => import('./comment-editor-fake.js'));

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let world: AttachmentWorld | undefined;
let picker: ReturnType<typeof countFilePicker>;

beforeEach(() => {
  editorUploads.chooserOpened.length = 0;
  picker = countFilePicker();
});

afterEach(async () => {
  await world?.unmount();
  world = undefined;
  clearToasts();
  vi.restoreAllMocks();
});

describe('Mod+Shift+U, "Attach file" (SPEC-012 §3.6)', () => {
  it.each(['mac', 'other'] as const)('opens the file picker on %s', async (platform) => {
    world = await mountAttachments({ platform, around });
    await keydown(document.body, 'U', modShiftU(platform));
    expect(picker.opened()).toBe(1);
  });

  it('fires while typing in a plain field, and still attaches to the issue', async () => {
    world = await mountAttachments({ around });
    await focus(field('Title'));
    await keydown(field('Title'), 'U', modShiftU('mac'));
    expect(picker.opened()).toBe(1);
    expect(editorUploads.chooserOpened).toEqual([]);
  });

  it("with focus in an editor, opens that editor's chooser to insert inline instead", async () => {
    world = await mountAttachments({ around });
    await focus(field('Comment'));
    await keydown(field('Comment'), 'U', modShiftU('mac'));
    expect(editorUploads.chooserOpened).toEqual(['Comment']);
    expect(picker.opened()).toBe(0);
  });
});

describe('Ctrl+L, "Link any URL to issue…" (SPEC-012 §3.6, D31)', () => {
  it('opens the link form with literal Control on macOS', async () => {
    world = await mountAttachments({ platform: 'mac' });
    await keydown(document.body, 'l', { code: 'KeyL', ctrlKey: true });
    expect(linkDialog()).toBeDefined();
  });

  it('is not bound elsewhere, where Ctrl+L is the browser’s address bar', async () => {
    world = await mountAttachments({ platform: 'other' });
    await keydown(document.body, 'l', { code: 'KeyL', ctrlKey: true });
    expect(linkDialog()).toBeUndefined();
  });
});

describe('a link is never fetched (AC-23, D9, D10)', () => {
  it('links, renders and opens a link with no request at all', async () => {
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      requests.push(input instanceof Request ? input.url : input.toString());
      return Promise.reject(new Error('no network in this test'));
    });
    const opened = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => {
      requests.push('xhr');
    });
    world = await mountAttachments();
    await press(document.querySelector('button[aria-label="Link any URL to issue"]'));
    const url = linkDialog()?.querySelector('input');
    if (!(url instanceof HTMLInputElement)) throw new Error('no field');
    await setValue(url, 'https://intranet.example/status');
    await press(
      [...(linkDialog()?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent === 'Add link',
      ),
    );
    await settle();
    const row = document.querySelector('[data-attachment-id]');
    expect(row?.textContent).toContain('intranet.example');
    // No preview, favicon or unfurl: the row shows a type icon, not an image from the site.
    expect(row?.querySelector('img')).toBeNull();
    expect(requests).toEqual([]);
    expect(opened).not.toHaveBeenCalled();
  });
});
