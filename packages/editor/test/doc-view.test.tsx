// @vitest-environment jsdom
// PLAN-013 S2: DocView follows the same rules as validateDoc and never mounts TipTap (SPEC-013
// §4.4, AC-14, E18).
import type { DocNodeJSON } from '@surface/domain';
import type * as TipTapCore from '@tiptap/core';
import fc from 'fast-check';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DocView, MISSING_IMAGE_MESSAGE, type DocViewProps } from '../src/DocView.js';
import { validateDoc } from '../src/schema/index.js';
import { doc as docArbitrary, propertyOptions } from './support/arbitraries.js';
import { BAD_HREFS, GOOD_HREFS } from './support/fixtures.js';
import { destroyAll, makeEditor } from './support/web-editor.js';

const created = vi.hoisted(() => ({ editors: 0 }));
vi.mock('@tiptap/core', async (importOriginal) => {
  const actual = await importOriginal<typeof TipTapCore>();
  class CountingEditor extends actual.Editor {
    constructor(...args: ConstructorParameters<typeof actual.Editor>) {
      super(...args);
      created.editors += 1;
    }
  }
  return { ...actual, Editor: CountingEditor };
});

const FILE = '0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7b';
const text = (value: string, marks: DocNodeJSON['marks'] = undefined): DocNodeJSON =>
  marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks };
const paragraph = (...content: DocNodeJSON[]): DocNodeJSON => ({ type: 'paragraph', content });
const doc = (...content: DocNodeJSON[]): DocNodeJSON => ({ type: 'doc', content });

function render(props: DocViewProps): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(createElement(DocView, props));
  return container;
}

describe('DocView renders the schema', () => {
  it('shows every block and mark', () => {
    const view = render({
      doc: doc(
        { type: 'heading', attrs: { level: 3 }, content: [text('Title')] },
        paragraph(
          text('all', [
            { type: 'bold' },
            { type: 'italic' },
            { type: 'underline' },
            { type: 'strike' },
          ]),
          { type: 'hardBreak' },
          text('code', [{ type: 'code' }]),
        ),
        { type: 'blockquote', content: [paragraph(text('quote'))] },
        {
          type: 'orderedList',
          content: [{ type: 'listItem', content: [paragraph(text('first'))] }],
        },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1;')] },
        { type: 'horizontalRule' },
      ),
    });
    expect(view.querySelector('h3')?.textContent).toBe('Title');
    expect(view.querySelector('strong em u s')?.textContent).toBe('all');
    expect(view.querySelector('br')).not.toBeNull();
    expect(view.querySelector('p code')?.textContent).toBe('code');
    expect(view.querySelector('blockquote')?.textContent).toBe('quote');
    expect(view.querySelector('ol > li')?.textContent).toBe('first');
    expect(view.querySelector('pre code.language-ts')?.textContent).toBe('const a = 1;');
    expect(view.querySelector('hr')).not.toBeNull();
  });
});

describe('DocView follows the link rule of validateDoc (AC-14)', () => {
  const linked = (href: unknown) =>
    doc(paragraph(text('label', [{ type: 'link', attrs: { href } }])));

  it.each(GOOD_HREFS)('renders %j as a safe link', (href) => {
    const anchor = render({ doc: linked(href) }).querySelector('a');
    expect(anchor?.getAttribute('href')).toBe(href);
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(anchor?.getAttribute('target')).toBe('_blank');
  });

  it.each(BAD_HREFS.map((href) => [href]))('renders %j as plain text, no link', (href) => {
    expect(validateDoc(linked(href)).ok).toBe(false);
    const view = render({ doc: linked(href) });
    expect(view.querySelector('a')).toBeNull();
    expect(view.textContent).toBe('label');
  });
});

describe('DocView images and files', () => {
  const image = (src: unknown) => doc({ type: 'image', attrs: { src, alt: 'shot' } });

  it('renders an image only for /files/<uuid>', () => {
    const view = render({ doc: image(`/files/${FILE}`) });
    expect(view.querySelector('img')?.getAttribute('src')).toBe(`/files/${FILE}`);
    expect(view.querySelector('img')?.getAttribute('alt')).toBe('shot');
  });

  it.each([
    'data:image/png;base64,AAAA',
    'blob:http://localhost/abc',
    'https://tracker.example/pixel.gif',
    '//evil.example/x.png',
    `/files/${FILE}/../other`,
    `/FILES/${FILE}`,
    '',
    42,
  ])('renders no image for the source %j', (src) => {
    expect(render({ doc: image(src) }).querySelector('img')).toBeNull();
  });

  it('shows a notice for an image whose file is gone, saying how to fix it (E18)', () => {
    const view = render({ doc: image(`/files/${FILE}`), missingFileIds: new Set([FILE]) });
    expect(view.querySelector('img')).toBeNull();
    expect(view.textContent).toBe(MISSING_IMAGE_MESSAGE);
    expect(MISSING_IMAGE_MESSAGE).toBe(
      'This image is no longer available. Remove it or upload it again.',
    );
  });

  it('renders a file chip as a download link, and a bad source as its name only', () => {
    const chip = (src: string) =>
      doc(paragraph({ type: 'file', attrs: { src, name: 'spec.pdf' } }));
    const good = render({ doc: chip(`/files/${FILE}`) }).querySelector('a');
    expect(good?.getAttribute('href')).toBe(`/files/${FILE}`);
    expect(good?.getAttribute('download')).toBe('spec.pdf');
    const bad = render({ doc: chip('https://evil.example/x') });
    expect(bad.querySelector('a')).toBeNull();
    expect(bad.textContent).toBe('spec.pdf');
  });
});

describe('DocView checklists', () => {
  const tasks = doc({
    type: 'taskList',
    content: [
      { type: 'taskItem', attrs: { checked: false }, content: [paragraph(text('open'))] },
      { type: 'taskItem', attrs: { checked: true }, content: [paragraph(text('done'))] },
    ],
  });

  it('disables the boxes when the host gives no onToggle', () => {
    const boxes = render({ doc: tasks }).querySelectorAll('input[type="checkbox"]');
    expect([...boxes].map((box) => box instanceof HTMLInputElement && box.checked)).toEqual([
      false,
      true,
    ]);
    expect([...boxes].every((box) => box instanceof HTMLInputElement && box.disabled)).toBe(true);
  });

  it('names each box by its text', () => {
    const boxes = render({ doc: tasks }).querySelectorAll('input[type="checkbox"]');
    expect([...boxes].map((box) => box.getAttribute('aria-label'))).toEqual(['open', 'done']);
  });

  it('enables the boxes with onToggle', () => {
    const box = render({ doc: tasks, onToggle: vi.fn() }).querySelector('input[type="checkbox"]');
    expect(box instanceof HTMLInputElement && box.disabled).toBe(false);
  });
});

describe('DocView never mounts TipTap (AC-14)', () => {
  it('renders documents without creating an editor or an editable area', () => {
    destroyAll();
    created.editors = 0;
    const view = render({ doc: doc(paragraph(text('hello')), { type: 'horizontalRule' }) });
    expect(created.editors).toBe(0);
    expect(view.querySelector('.ProseMirror, [contenteditable]')).toBeNull();
    // The counter works: a real editor does count.
    makeEditor();
    expect(created.editors).toBe(1);
    destroyAll();
  });
});

describe('DocView on any valid document', () => {
  it('renders it without throwing, with no script, no event handler and no unchecked link', () => {
    fc.assert(
      fc.property(docArbitrary, (generated) => {
        const html = renderToStaticMarkup(createElement(DocView, { doc: generated }));
        expect(html).not.toMatch(/<script|\son[a-z]+=|href="javascript:/i);
        for (const match of html.matchAll(/<(?:img|a)\s[^>]*?(?:src|href)="([^"]*)"/g)) {
          const target = match[1] ?? '';
          expect(/^(?:https?:\/\/|mailto:|\/files\/)/i.test(target)).toBe(true);
        }
      }),
      propertyOptions,
    );
  });
});
