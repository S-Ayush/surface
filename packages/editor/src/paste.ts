/**
 * Paste handling (SPEC-013 §4.4 "Paste", D9, E11, E19). Clipboard HTML is parsed with `DOMParser`
 * into a detached document, so nothing loads (no image, script or stylesheet requests). It is
 * cleaned there, then ProseMirror's own parser maps it through the schema's parse rules: whatever
 * the schema doesn't know becomes its text. Links survive only if they pass the link rule.
 */
import { Extension, type Editor } from '@tiptap/core';
import { DOC_MAX_BYTES } from '@surface/domain';
import { Slice, type Fragment } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { markdownToDoc } from './schema/markdown.js';
import { fileIdOfSrc, isAllowedHref } from './schema/links.js';
import { uploadAndInsert, type UploadFile } from './upload.js';

const REMOVED_TAGS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'video',
  'audio',
  'source',
  'svg',
  'noscript',
  'template',
  'title',
  'head',
];

export interface SanitizedPaste {
  readonly html: string;
  /** `data:` and `blob:` image sources: the host uploads them, then inserts them (E11). */
  readonly uploads: readonly string[];
}

let lastSanitized: { readonly input: string; readonly result: SanitizedPaste } | null = null;

/**
 * Cleans clipboard HTML in a detached document. Pure: it loads and runs nothing. A paste asks
 * twice (`handlePaste` for the uploads, `transformPastedHTML` for the markup), so the last result
 * is kept and the HTML is parsed once.
 */
export function sanitizePastedHtml(html: string): SanitizedPaste {
  if (lastSanitized?.input === html) return lastSanitized.result;
  const result = sanitize(html);
  lastSanitized = { input: html, result };
  return result;
}

function sanitize(html: string): SanitizedPaste {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const uploads: string[] = [];
  for (const element of Array.from(parsed.body.querySelectorAll(REMOVED_TAGS.join(',')))) {
    element.remove();
  }
  for (const image of Array.from(parsed.body.querySelectorAll('img'))) {
    const src = image.getAttribute('src') ?? '';
    const alt = image.getAttribute('alt') ?? '';
    if (/^(?:data|blob):/i.test(src)) {
      uploads.push(src);
      image.remove();
    } else if (fileIdOfSrc(src) !== null) {
      continue; // one of our own uploaded files
    } else if (isAllowedHref(src) && image.closest('a') === null) {
      // E19: an external image becomes a link to its URL, with the alt text.
      const link = parsed.createElement('a');
      link.setAttribute('href', src);
      link.textContent = alt !== '' ? alt : src;
      image.replaceWith(link);
    } else {
      image.replaceWith(parsed.createTextNode(alt));
    }
  }
  return { html: parsed.body.innerHTML, uploads };
}

/**
 * Text is read as Markdown only with a block sign at a line start (heading, quote, list, fence,
 * task, divider) or a balanced inline pair (`code`, **bold**, [text](url)). A stray backtick,
 * underscore or `](` in prose pastes verbatim.
 */
const MARKDOWN_SIGNS = new RegExp(
  [
    '^(?:#{1,4} |> |[-*+] |\\d+\\. |```|\\[[ xX]\\] |---$)',
    '`[^`\\n]+`',
    '\\*\\*[^*\\n]+\\*\\*',
    '\\[[^\\]\\n]+\\]\\([^)\\s]+\\)',
  ].join('|'),
  'm',
);

/** The largest pasted image the editor will try to upload: `UPLOAD_MAX_MB`'s default (SPEC-014). */
export const PASTED_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

export class PastedImageTooLarge extends Error {
  constructor() {
    super('That image is larger than 25 MB. Save a smaller one and upload the file.');
  }
}

/** A `data:` or `blob:` image source as a file to upload. */
export async function fileFromImageSource(src: string): Promise<File> {
  if (/^blob:/i.test(src)) {
    // A same-origin object URL: this reads memory, not the network.
    const blob = await (await fetch(src)).blob();
    if (blob.size > PASTED_IMAGE_MAX_BYTES) throw new PastedImageTooLarge();
    return new File([blob], `pasted-image.${extensionOf(blob.type)}`, { type: blob.type });
  }
  const comma = src.indexOf(',');
  const head = src.slice(5, comma);
  const type = head.split(';')[0] || 'image/png';
  const body = src.slice(comma + 1);
  // Estimated from the text, before anything is decoded: base64 is 4 characters per 3 bytes.
  const estimate = head.includes(';base64') ? Math.floor((body.length * 3) / 4) : body.length;
  if (estimate > PASTED_IMAGE_MAX_BYTES) throw new PastedImageTooLarge();
  const bytes = head.includes(';base64')
    ? Uint8Array.from(atob(body), (char) => char.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(body));
  return new File([bytes], `pasted-image.${extensionOf(type)}`, { type });
}

function extensionOf(type: string): string {
  const subtype = type.split('/')[1]?.split('+')[0] ?? '';
  return /^[a-z0-9]{1,8}$/.test(subtype) ? subtype : 'png';
}

export interface PasteOptions {
  readonly upload: () => UploadFile;
  readonly onError: () => (message: string) => void;
}

/** ProseMirror marks a Mod+Shift+V paste on its (untyped) input state. */
function isPlainTextPaste(view: object): boolean {
  const input: unknown = Reflect.get(view, 'input');
  return typeof input === 'object' && input !== null && Reflect.get(input, 'shiftKey') === true;
}

export function pasteExtension(options: PasteOptions): Extension {
  return Extension.create({
    name: 'surfacePaste',
    addProseMirrorPlugins() {
      const { editor } = this;
      const upload = (file: File) =>
        uploadAndInsert(editor, file, options.upload(), options.onError());
      return [
        new Plugin({
          key: new PluginKey('surfacePaste'),
          props: {
            transformPastedHTML: (html) => sanitizePastedHtml(html).html,
            handlePaste: (view, event) => {
              const data = event.clipboardData;
              if (data === null || !view.editable) return false;
              // Mod+Shift+V: ProseMirror sets `input.shiftKey` and parses the text alone. Insert
              // exactly that: no upload, no Markdown, no link.
              if (isPlainTextPaste(view)) return false;
              const html = data.getData('text/html');
              const text = data.getData('text/plain');
              const files = Array.from(data.files);

              // A copied image or file with no text of its own: upload the files.
              if (files.length > 0 && text.trim() === '') {
                for (const file of files) void upload(file);
                return true;
              }
              if (html !== '') {
                for (const src of sanitizePastedHtml(html).uploads) {
                  void fileFromImageSource(src).then(upload, (error: unknown) => {
                    options.onError()(
                      error instanceof PastedImageTooLarge
                        ? error.message
                        : "That image couldn't be read. Save it and upload the file.",
                    );
                  });
                }
                return false;
              }
              return pastePlainText(editor, text);
            },
          },
        }),
      ];
    },
  });
}

/** Plain text: a bare URL over a selection, or Markdown. Returns whether it handled the paste. */
function pastePlainText(editor: Editor, text: string): boolean {
  const { state } = editor;
  const { selection } = state;
  if (selection.$from.parent.type.spec.code === true) return false;
  const trimmed = text.trim();
  if (
    !selection.empty &&
    selection instanceof TextSelection &&
    isAllowedHref(trimmed) &&
    !/\s/.test(trimmed)
  ) {
    return editor.chain().setMark('link', { href: trimmed }).run();
  }
  if (!MARKDOWN_SIGNS.test(text) || text.length > DOC_MAX_BYTES.description) return false;
  const doc = state.schema.nodeFromJSON(markdownToDoc(text));
  const only = doc.childCount === 1 ? doc.firstChild : null;
  const content: Fragment =
    only !== null && only.type.name === 'paragraph' ? only.content : doc.content;
  return editor.commands.command(({ tr }) => {
    tr.replaceSelection(new Slice(content, 0, 0)).scrollIntoView();
    return true;
  });
}
