/**
 * `@surface/editor/schema`: the headless entry (SPEC-013 §4.4). No DOM, no React, no lowlight,
 * and no Editor instance, so the server can import it (`server-editor-schema-only`) and it runs
 * in plain Node (AC-10). It builds to `dist/schema` for the server image.
 */
export { schema } from './schema.js';
export { SCHEMA_EXTENSIONS } from './extensions.js';
export { validateDoc, DOC_MESSAGES, MAX_FILE_REFERENCES } from './validate.js';
export type { DocPath, DocProblem, ValidateDocResult } from './validate.js';
export { normalize } from './normalize.js';
export { docToText } from './text.js';
export { docToMarkdown, markdownToDoc } from './markdown.js';
export { docFileIds } from './files.js';
export { fileIdOfSrc, fileSrc, isAllowedHref } from './links.js';
export { isSingleEmoji } from './emoji.js';
