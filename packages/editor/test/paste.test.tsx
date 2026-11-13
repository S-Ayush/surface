// @vitest-environment jsdom
// PLAN-013 S2: paste (SPEC-013 §4.4 "Paste", AC-14, E11 insert logic, E19, D9).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fileFromImageSource,
  PASTED_IMAGE_MAX_BYTES,
  PastedImageTooLarge,
  sanitizePastedHtml,
} from '../src/paste.js';
import { destroyAll, docOf, makeEditor, paragraph, type Harness } from './support/web-editor.js';

afterEach(() => {
  destroyAll();
  vi.unstubAllGlobals();
});

const FILE = '/files/0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7b';
// A 1x1 transparent PNG.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function isClipboardEvent(event: Event): event is ClipboardEvent {
  return 'clipboardData' in event;
}

function clipboard(data: { html?: string; text?: string; files?: File[] }): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => (type === 'text/html' ? data.html : data.text) ?? '',
      files: data.files ?? [],
    },
  });
  if (!isClipboardEvent(event)) throw new Error('unreachable: clipboardData was just defined');
  return event;
}

function pasteHtml(harness: Harness, html: string, text = ''): void {
  harness.editor.view.pasteHTML(html, clipboard({ html, text }));
}

const content = (harness: Harness) => harness.json().content;
const link = (href: string) => ({ type: 'link', attrs: { href } });

describe('pasted HTML (AC-14)', () => {
  it('is parsed without loading anything', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const harness = makeEditor({ mode: 'description' });
    pasteHtml(
      harness,
      '<p>hi</p><img src="https://tracker.example/pixel.gif"><link rel="stylesheet" href="https://cdn.example/a.css"><script>fetch("https://evil.example")</script>',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.querySelector('img[src^="https://tracker"]')).toBeNull();
    expect(document.querySelector('script, link')).toBeNull();
  });

  it('keeps no text of scripts and styles', () => {
    const { html } = sanitizePastedHtml(
      '<style>p{color:red}</style><p>keep</p><script>alert(1)</script><iframe src="https://www.youtube.com/embed/x"></iframe>',
    );
    expect(html).toBe('<p>keep</p>');
  });

  it('turns what the schema does not know into its text', () => {
    const harness = makeEditor({ mode: 'description' });
    pasteHtml(harness, '<custom-tag>hello</custom-tag> <table><tr><td>cell</td></tr></table>');
    expect(JSON.stringify(content(harness))).toContain('hello');
    expect(JSON.stringify(content(harness))).toContain('cell');
    expect(JSON.stringify(content(harness))).not.toContain('table');
  });

  it('keeps links that pass the link rule and drops the rest, keeping their text (E6)', () => {
    const harness = makeEditor({ mode: 'description' });
    pasteHtml(
      harness,
      '<p><a href="https://ok.example/x">fine</a> <a href="javascript:alert(1)">script</a> <a href="//evil.example">proto</a> <a href="/relative">rel</a></p>',
    );
    expect(content(harness)).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'fine', marks: [link('https://ok.example/x')] },
          { type: 'text', text: ' script proto rel' },
        ],
      },
    ]);
  });

  it('turns an external image into a link with its alt text (E19)', () => {
    const harness = makeEditor({ mode: 'description' });
    pasteHtml(harness, '<p>see <img src="https://example.com/a.png" alt="the diagram"></p>');
    expect(content(harness)).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'see ' },
          { type: 'text', text: 'the diagram', marks: [link('https://example.com/a.png')] },
        ],
      },
    ]);
  });

  it('uses the address as the link text when the external image has no alt text', () => {
    const { html } = sanitizePastedHtml('<img src="https://example.com/a.png">');
    expect(html).toContain('>https://example.com/a.png</a>');
  });

  it('keeps an image that is one of our own uploaded files', () => {
    const harness = makeEditor({ mode: 'description' });
    pasteHtml(harness, `<img src="${FILE}" alt="shot">`);
    expect(content(harness)?.some((node) => node.type === 'image')).toBe(true);
  });

  it('keeps embeds as plain links, never as an embed (D9)', () => {
    const harness = makeEditor({ mode: 'description' });
    pasteHtml(
      harness,
      '<iframe src="https://www.youtube.com/embed/x"></iframe><p><a href="https://www.youtube.com/watch?v=x">video</a></p>',
    );
    expect(JSON.stringify(content(harness))).not.toContain('iframe');
    expect(JSON.stringify(content(harness))).toContain('https://www.youtube.com/watch?v=x');
  });
});

describe('pasted images and files (E11 insert logic)', () => {
  it('uploads a pasted data: image and inserts it when the upload finishes', async () => {
    const harness = makeEditor({ mode: 'description' });
    harness.upload.mockResolvedValue({ src: FILE, name: 'pasted-image.png', kind: 'image' });
    pasteHtml(harness, `<p>x</p><img src="${PNG}">`);
    await vi.waitFor(() => {
      expect(content(harness)?.some((node) => node.type === 'image')).toBe(true);
    });
    expect(harness.upload).toHaveBeenCalledOnce();
    const file = harness.upload.mock.calls[0]?.[0];
    expect(file).toBeInstanceOf(File);
    expect(file?.type).toBe('image/png');
    expect(JSON.stringify(content(harness))).not.toContain('data:');
  });

  it('reads a blob: image source as a file for the hook', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ blob: () => Promise.resolve(new Blob(['x'], { type: 'image/png' })) }),
      ),
    );
    const file = await fileFromImageSource('blob:http://localhost/abc');
    expect(file.name).toBe('pasted-image.png');
    expect(file.type).toBe('image/png');
  });

  it('uploads a copied file that has no text, and takes the paste', async () => {
    const harness = makeEditor({ mode: 'description' });
    harness.upload.mockResolvedValue({ src: FILE, name: 'spec.pdf', kind: 'file' });
    const pdf = new File(['x'], 'spec.pdf', { type: 'application/pdf' });
    const event = clipboard({ files: [pdf] });
    const handled = harness.editor.view.someProp('handlePaste', (handler) =>
      handler(harness.editor.view, event, harness.editor.state.doc.slice(0, 0)),
    );
    expect(handled).toBe(true);
    await vi.waitFor(() => {
      expect(JSON.stringify(content(harness))).toContain('"type":"file"');
    });
    expect(harness.upload).toHaveBeenCalledWith(pdf);
  });

  it('reports a refused upload instead of inserting anything', async () => {
    const harness = makeEditor({ mode: 'description' });
    harness.upload.mockRejectedValue(new Error("Uploading files isn't available yet."));
    pasteHtml(harness, `<img src="${PNG}">`);
    await vi.waitFor(() => {
      expect(harness.errors).toEqual(["Uploading files isn't available yet."]);
    });
    expect(content(harness)?.some((node) => node.type === 'image')).toBe(false);
  });

  it('refuses an upload result that is not a /files/<uuid> source', async () => {
    const harness = makeEditor({ mode: 'description' });
    harness.upload.mockResolvedValue({
      src: 'https://evil.example/x.png',
      name: 'x',
      kind: 'image',
    });
    pasteHtml(harness, `<img src="${PNG}">`);
    await vi.waitFor(() => {
      expect(harness.errors).toHaveLength(1);
    });
    expect(content(harness)?.some((node) => node.type === 'image')).toBe(false);
  });
});

describe('pasted text', () => {
  it('makes a bare URL pasted over a selection a link', () => {
    const harness = makeEditor({ content: docOf(paragraph('docs')) });
    harness.editor.commands.setTextSelection({ from: 1, to: 5 });
    harness.editor.view.pasteText(
      'https://example.com/docs',
      clipboard({ text: 'https://example.com/docs' }),
    );
    expect(content(harness)).toEqual([
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'docs', marks: [link('https://example.com/docs')] }],
      },
    ]);
  });

  it('does not link a URL that fails the link rule', () => {
    const harness = makeEditor({ content: docOf(paragraph('docs')) });
    harness.editor.commands.setTextSelection({ from: 1, to: 5 });
    harness.editor.view.pasteText(
      'javascript:alert(1)',
      clipboard({ text: 'javascript:alert(1)' }),
    );
    expect(JSON.stringify(content(harness))).not.toContain('"link"');
  });

  it('pastes a bare URL with no selection as plain text', () => {
    const harness = makeEditor();
    harness.editor.view.pasteText(
      'https://www.loom.com/share/x',
      clipboard({ text: 'https://www.loom.com/share/x' }),
    );
    expect(content(harness)).toEqual([paragraph('https://www.loom.com/share/x')]);
  });

  it('converts pasted Markdown to the schema', () => {
    const harness = makeEditor({ mode: 'description' });
    const markdown = '# Title\n\n- one\n- **two**';
    harness.editor.view.pasteText(markdown, clipboard({ text: markdown }));
    expect(content(harness)?.map((node) => node.type)).toEqual(['heading', 'bulletList']);
  });

  it('leaves plain prose to the default paste', () => {
    const harness = makeEditor();
    harness.editor.view.pasteText('just words', clipboard({ text: 'just words' }));
    expect(content(harness)).toEqual([paragraph('just words')]);
  });
});

describe('plain-text paste, Mod+Shift+V', () => {
  /** ProseMirror sets `input.shiftKey` for that paste. */
  function plain(harness: Harness): void {
    const input: unknown = Reflect.get(harness.editor.view, 'input');
    if (typeof input !== 'object' || input === null) throw new Error('no input state');
    Reflect.set(input, 'shiftKey', true);
  }

  it('does not upload pasted data: images', () => {
    const harness = makeEditor({ mode: 'description' });
    plain(harness);
    pasteHtml(harness, `<img src="${PNG}">`, 'plain words');
    expect(harness.upload).not.toHaveBeenCalled();
  });

  it('inserts Markdown text as it is', () => {
    const harness = makeEditor({ mode: 'description' });
    plain(harness);
    harness.editor.view.pasteText('# Title\n\n- one', clipboard({ text: '# Title\n\n- one' }));
    expect(JSON.stringify(content(harness))).not.toContain('heading');
    expect(JSON.stringify(content(harness))).not.toContain('bulletList');
    expect(JSON.stringify(content(harness))).toContain('# Title');
  });

  it('does not turn a URL over a selection into a link', () => {
    const harness = makeEditor({ content: docOf(paragraph('docs')) });
    harness.editor.commands.setTextSelection({ from: 1, to: 5 });
    plain(harness);
    harness.editor.view.pasteText(
      'https://example.com',
      clipboard({ text: 'https://example.com' }),
    );
    expect(JSON.stringify(content(harness))).not.toContain('"link"');
    expect(JSON.stringify(content(harness))).toContain('https://example.com');
  });
});

describe('pasted prose is not read as Markdown by a stray sign', () => {
  it.each([
    // Each has an HTML entity that Markdown would decode: converting would change the text.
    "it's a__b &amp; c",
    'use ` here &lt;b&gt;',
    'a ](b) c &amp; d',
    'snake_case_name and a~~b &amp; c',
    'price is 5 * 3 * 2 &amp; more',
  ])('pastes %j verbatim', (prose) => {
    const harness = makeEditor();
    harness.editor.view.pasteText(prose, clipboard({ text: prose }));
    expect(content(harness)).toEqual([paragraph(prose)]);
  });

  it.each([
    ['use `code` here', 'code'],
    ['say **hi**', 'bold'],
    ['see [docs](https://example.com)', 'link'],
  ])('still converts %j (a balanced pair)', (markdown, mark) => {
    const harness = makeEditor();
    harness.editor.view.pasteText(markdown, clipboard({ text: markdown }));
    expect(JSON.stringify(content(harness))).toContain(`"type":"${mark}"`);
  });
});

describe('pasted image size', () => {
  const oversized = `data:image/png;base64,${'A'.repeat(Math.ceil((PASTED_IMAGE_MAX_BYTES * 4) / 3) + 8)}`;

  it('refuses a data: image over the upload limit before decoding it', async () => {
    const decode = vi.spyOn(globalThis, 'atob');
    await expect(fileFromImageSource(oversized)).rejects.toBeInstanceOf(PastedImageTooLarge);
    expect(decode).not.toHaveBeenCalled();
    decode.mockRestore();
  });

  it('refuses a blob: image over the limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          blob: () => Promise.resolve({ size: PASTED_IMAGE_MAX_BYTES + 1, type: 'image/png' }),
        }),
      ),
    );
    await expect(fileFromImageSource('blob:http://localhost/x')).rejects.toBeInstanceOf(
      PastedImageTooLarge,
    );
  });

  it('reports it through onError with a message that says what to do', async () => {
    const harness = makeEditor({ mode: 'description' });
    pasteHtml(harness, `<img src="${oversized}">`);
    await vi.waitFor(() => {
      expect(harness.errors).toEqual([
        'That image is larger than 25 MB. Save a smaller one and upload the file.',
      ]);
    });
    expect(harness.upload).not.toHaveBeenCalled();
  });

  it('still reads an image under the limit', async () => {
    const file = await fileFromImageSource(PNG);
    expect(file.size).toBeGreaterThan(0);
  });
});

describe('sanitizePastedHtml parses once per paste', () => {
  it('reuses the last result for the same HTML', () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const html = `<p>unique ${String(Math.random())}</p>`;
    const first = sanitizePastedHtml(html);
    expect(sanitizePastedHtml(html)).toBe(first);
    expect(parse).toHaveBeenCalledTimes(1);
    parse.mockRestore();
  });

  it('parses once for a whole paste', () => {
    const harness = makeEditor({ mode: 'description' });
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    pasteHtml(harness, `<p>whole paste ${String(Math.random())}</p>`);
    expect(parse).toHaveBeenCalledTimes(1);
    parse.mockRestore();
  });
});
