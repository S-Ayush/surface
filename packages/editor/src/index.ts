// The React entry of the editor (SPEC-013 §4.4). The headless schema entry is `@surface/editor/schema`.
export const EDITOR_PACKAGE = '@surface/editor';
export { RichTextEditor } from './RichTextEditor.js';
export type { RichTextEditorHandle, RichTextEditorProps } from './RichTextEditor.js';
export { DocView, MISSING_IMAGE_MESSAGE } from './DocView.js';
export type { DocViewProps } from './DocView.js';
export type { UploadedFile, UploadFile } from './upload.js';
export type { EditorMode } from './keymap.js';
export { loadEmoji, loadedEmoji } from './emoji/data.js';
export type { Emoji } from './emoji/data.js';
export { searchEmoji } from './emoji/autocomplete.js';
export { isSingleEmoji } from './schema/emoji.js';
