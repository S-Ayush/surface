// A real web editor in jsdom, with the production extensions, for the key, rule and paste tests.
import { EMPTY_DOC, type DocNodeJSON } from '@surface/domain';
import { Editor } from '@tiptap/core';
import { vi } from 'vitest';
import { toContent } from '../../src/content.js';
import { webEditorOptions, webExtensions } from '../../src/extensions.web.js';
import type { KeyHandlers } from '../../src/keymap.js';
import { nodeJSON } from '../../src/schema/schema.js';
import type { UploadFile } from '../../src/upload.js';
import './layout.js';

export interface Harness {
  readonly editor: Editor;
  readonly submit: ReturnType<typeof vi.fn>;
  readonly openLink: ReturnType<typeof vi.fn>;
  readonly upload: ReturnType<typeof vi.fn<UploadFile>>;
  readonly errors: string[];
  json(): DocNodeJSON;
  destroy(): void;
}

const live: Harness[] = [];

export function makeEditor(
  options: { mode?: 'comment' | 'description'; content?: DocNodeJSON } = {},
): Harness {
  const submit = vi.fn();
  const openLink = vi.fn();
  const upload = vi.fn<UploadFile>();
  const errors: string[] = [];
  const handlers = {
    current: { mode: options.mode ?? 'comment', onSubmit: submit, openLink } satisfies KeyHandlers,
  };
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    ...webEditorOptions,
    extensions: webExtensions({
      handlers,
      placeholder: '',
      upload: () => upload,
      onError: () => (message) => errors.push(message),
      canToggle: (editable) => editable,
      onSlash: () => undefined,
      onEmoji: () => undefined,
      chooseFile: () => undefined,
    }),
    content: toContent(options.content ?? EMPTY_DOC),
  });
  const harness: Harness = {
    editor,
    submit,
    openLink,
    upload,
    errors,
    json: () => nodeJSON(editor.state.doc),
    destroy: () => {
      editor.destroy();
      element.remove();
    },
  };
  live.push(harness);
  return harness;
}

export function destroyAll(): void {
  for (const harness of live.splice(0)) harness.destroy();
}

export interface Key {
  readonly key: string;
  readonly code?: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

/** Sends a `keydown` to the editor as a browser would; returns the event (check `defaultPrevented`). */
export function press(editor: Editor, key: Key): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: key.key,
    keyCode: key.key.length === 1 ? key.key.toUpperCase().charCodeAt(0) : 0,
    code: key.code ?? '',
    ctrlKey: key.ctrl ?? false,
    shiftKey: key.shift ?? false,
    altKey: key.alt ?? false,
    bubbles: true,
    cancelable: true,
  });
  editor.view.dom.dispatchEvent(event);
  return event;
}

/** Types text the way ProseMirror receives it (so input rules run). */
export function type(editor: Editor, text: string): void {
  const { view } = editor;
  for (const char of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (handler) =>
      handler(view, from, to, char, () => view.state.tr.insertText(char, from, to)),
    );
    if (handled !== true) view.dispatch(view.state.tr.insertText(char, from, to));
  }
}

export const paragraph = (text?: string): DocNodeJSON =>
  text === undefined
    ? { type: 'paragraph' }
    : { type: 'paragraph', content: [{ type: 'text', text }] };

export const docOf = (...content: DocNodeJSON[]): DocNodeJSON => ({ type: 'doc', content });
