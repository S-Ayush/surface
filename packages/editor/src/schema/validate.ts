/**
 * `validateDoc` (SPEC-013 §4.4, AC-7): a stored document must match the schema exactly, follow
 * the link and file rules, and reference at most 50 files. Size limits are the caller's
 * (`DOC_MAX_BYTES`). Every problem carries the JSON path of the part that is wrong, so an API
 * caller can find it (E6).
 */
import type { DocNodeJSON } from '@surface/domain';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Mark } from '@tiptap/pm/model';
import { fileIdOfSrc, isAllowedHref, isCodeLanguage, isWellFormedText } from './links.js';
import { nodeJSON, schema } from './schema.js';

export type DocPath = (string | number)[];

export interface DocProblem {
  readonly path: DocPath;
  readonly message: string;
}

export type ValidateDocResult =
  | { readonly ok: true; readonly doc: DocNodeJSON }
  | { readonly ok: false; readonly problems: readonly DocProblem[] };

/** At most this many images and file chips in one document (SPEC-013 §4.4). */
export const MAX_FILE_REFERENCES = 50;
const MAX_PROBLEMS = 20;
const MAX_DEPTH = 64;

/** The SPEC-013 §6.3 and SPEC-014 §4.3 sentences, and the generic schema ones. */
export const DOC_MESSAGES = {
  badLink: "That link isn't allowed. Use an http, https or mailto link.",
  badImage: 'Images must be uploaded files. Drop or paste the image instead of linking it.',
  badFile: "A file in this text can't be used here. Upload it again.",
  tooManyFiles: `Use at most ${MAX_FILE_REFERENCES} images and files in one text. Attach the rest to the issue.`,
  notADoc: 'The text must be a document: {"type": "doc", "content": [...]}, or Markdown.',
  notAnObject: 'Each part of the text must be a JSON object with a "type".',
  emptyText: "Text can't be empty. Remove the empty text part.",
  codeWithMarks: "Inline code can't have other formatting. Remove the other formatting.",
  tooDeep: `The text is nested more than ${MAX_DEPTH} levels deep. Flatten its lists or quotes.`,
  brokenText: "Text can't contain NUL characters or broken Unicode. Remove them.",
} as const;

/** A name from the caller, cut to 40 characters, for a message (never echo a whole payload). */
function shown(name: string): string {
  return name.length > 40 ? `${name.slice(0, 40)}…` : name;
}

const NODE_KEYS = new Set(['type', 'attrs', 'content', 'marks', 'text']);
const MARK_KEYS = new Set(['type', 'attrs']);

type AttrCheck = (value: unknown) => string | null;

const optionalString =
  (what: string, max: number): AttrCheck =>
  (value) => {
    if (value === null) return null;
    if (typeof value !== 'string' || value.length > max) {
      return `${what} must be text of at most ${max} characters.`;
    }
    return isWellFormedText(value) ? null : DOC_MESSAGES.brokenText;
  };

/** Allowed attributes per node and mark, with the check of each value (SPEC-013 §4.4). */
const ATTRS: Record<string, Record<string, AttrCheck>> = {
  heading: {
    level: (value) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 4
        ? null
        : 'Heading level must be 1, 2, 3 or 4.',
  },
  taskItem: {
    checked: (value) => (typeof value === 'boolean' ? null : 'Checked must be true or false.'),
  },
  codeBlock: {
    language: (value) =>
      value === null || (typeof value === 'string' && isCodeLanguage(value))
        ? null
        : 'Code language must be a short name like typescript, or null.',
  },
  image: {
    src: (value) =>
      typeof value === 'string' && fileIdOfSrc(value) !== null ? null : DOC_MESSAGES.badImage,
    alt: optionalString('Image alt text', 1000),
  },
  file: {
    src: (value) =>
      typeof value === 'string' && fileIdOfSrc(value) !== null ? null : DOC_MESSAGES.badFile,
    name: (value) => {
      if (typeof value !== 'string' || value.length === 0 || value.length > 1000) {
        return 'File name must be text of 1 to 1000 characters.';
      }
      return isWellFormedText(value) ? null : DOC_MESSAGES.brokenText;
    },
  },
  link: {
    href: (value) => {
      if (typeof value !== 'string' || !isAllowedHref(value)) return DOC_MESSAGES.badLink;
      // `new URL` accepts a lone surrogate (it encodes U+FFFD); the stored string can't hold it.
      return isWellFormedText(value) ? null : DOC_MESSAGES.brokenText;
    },
  },
};

/** Attributes that must be present (they have no meaningful default). */
const REQUIRED_ATTRS: Record<string, readonly string[]> = {
  image: ['src'],
  file: ['src', 'name'],
  link: ['href'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Checker {
  readonly problems: DocProblem[] = [];
  fileReferences = 0;

  add(path: DocPath, message: string): void {
    if (this.problems.length < MAX_PROBLEMS) this.problems.push({ path, message });
  }

  attrs(owner: string, attrs: unknown, path: DocPath): void {
    const allowed = (Object.hasOwn(ATTRS, owner) ? ATTRS[owner] : undefined) ?? {};
    const given = attrs === undefined ? {} : attrs;
    if (!isRecord(given)) {
      this.add([...path, 'attrs'], `Attributes of "${owner}" must be a JSON object.`);
      return;
    }
    for (const [key, value] of Object.entries(given)) {
      // Own keys only: `constructor` or `__proto__` from the caller must not reach a check.
      const check = Object.hasOwn(allowed, key) ? allowed[key] : undefined;
      if (check === undefined) {
        this.add(
          [...path, 'attrs', key],
          `"${owner}" has no attribute "${shown(key)}". Remove it.`,
        );
        continue;
      }
      const problem = check(value);
      if (problem !== null) this.add([...path, 'attrs', key], problem);
    }
    for (const key of (Object.hasOwn(REQUIRED_ATTRS, owner) ? REQUIRED_ATTRS[owner] : []) ?? []) {
      if (!Object.hasOwn(given, key)) {
        const problem = allowed[key]?.(undefined) ?? `"${owner}" needs "${key}".`;
        this.add([...path, 'attrs', key], problem);
      }
    }
  }

  marks(marks: unknown, path: DocPath): void {
    if (marks === undefined) return;
    if (!Array.isArray(marks)) {
      this.add([...path, 'marks'], 'Marks must be a list.');
      return;
    }
    marks.forEach((mark: unknown, i) => {
      const markPath = [...path, 'marks', i];
      if (!isRecord(mark) || typeof mark['type'] !== 'string') {
        this.add(markPath, DOC_MESSAGES.notAnObject);
        return;
      }
      const type = mark['type'];
      if (!Object.hasOwn(schema.marks, type)) {
        this.add(
          [...markPath, 'type'],
          `Unknown formatting "${shown(type)}". Use bold, italic, underline, strikethrough, code or links, or send Markdown.`,
        );
        return;
      }
      for (const key of Object.keys(mark)) {
        if (!MARK_KEYS.has(key)) {
          this.add([...markPath, key], `Unknown field "${shown(key)}". Remove it.`);
        }
      }
      this.attrs(type, mark['attrs'], markPath);
    });
  }

  node(node: unknown, path: DocPath, depth: number): void {
    if (depth > MAX_DEPTH) {
      this.add(path, DOC_MESSAGES.tooDeep);
      return;
    }
    if (!isRecord(node) || typeof node['type'] !== 'string') {
      this.add(path, depth === 0 ? DOC_MESSAGES.notADoc : DOC_MESSAGES.notAnObject);
      return;
    }
    const type = node['type'];
    if (depth === 0 && type !== 'doc') {
      this.add([...path, 'type'], DOC_MESSAGES.notADoc);
      return;
    }
    if (!Object.hasOwn(schema.nodes, type)) {
      this.add(
        [...path, 'type'],
        `Unknown block or element "${shown(type)}". Use only what the Surface editor makes, or send Markdown.`,
      );
      return;
    }
    for (const key of Object.keys(node)) {
      if (!NODE_KEYS.has(key))
        this.add([...path, key], `Unknown field "${shown(key)}". Remove it.`);
    }
    if (type === 'image' || type === 'file') this.fileReferences++;
    this.attrs(type, node['attrs'], path);
    this.marks(node['marks'], path);

    const text = node['text'];
    if (type === 'text') {
      if (typeof text !== 'string' || text.length === 0) this.add(path, DOC_MESSAGES.emptyText);
      else if (!isWellFormedText(text)) this.add([...path, 'text'], DOC_MESSAGES.brokenText);
      if (node['content'] !== undefined) this.add([...path, 'content'], 'Text has no content.');
      return;
    }
    if (text !== undefined) this.add([...path, 'text'], `"${type}" has no text field.`);
    const content = node['content'];
    if (content === undefined) return;
    if (!Array.isArray(content)) {
      this.add([...path, 'content'], 'Content must be a list.');
      return;
    }
    content.forEach((child: unknown, i) => this.node(child, [...path, 'content', i], depth + 1));
  }

  /** Content expressions and mark combinations, on the parsed document. */
  structure(node: PMNode, path: DocPath): void {
    if (!node.type.validContent(node.content)) {
      this.add(path, contentMessage(node));
    }
    if (node.isText) {
      let set = Mark.none;
      for (const mark of node.marks) set = mark.addToSet(set);
      if (!Mark.sameSet(set, node.marks)) {
        const message = node.marks.some((mark) => mark.type.name === 'code')
          ? DOC_MESSAGES.codeWithMarks
          : 'The same formatting appears twice on this text. Remove one.';
        this.add([...path, 'marks'], message);
      }
    }
    node.forEach((child, _offset, i) => this.structure(child, [...path, 'content', i]));
  }
}

function contentMessage(node: PMNode): string {
  switch (node.type.name) {
    case 'listItem':
    case 'taskItem':
      return 'A list item must start with a paragraph.';
    case 'bulletList':
    case 'orderedList':
      return 'A list may contain only list items.';
    case 'taskList':
      return 'A checklist may contain only checklist items.';
    case 'codeBlock':
      return 'A code block may contain only plain text.';
    case 'doc':
    case 'blockquote':
      return node.childCount === 0
        ? 'This part needs at least one paragraph.'
        : 'This part may contain only blocks, such as paragraphs and lists.';
    default:
      return `"${node.type.name}" can't contain this content.`;
  }
}

/**
 * Check a document against the schema. Returns the document in its canonical JSON form (marks
 * in schema order, attribute defaults filled in) or the problems found, each with its path.
 */
export function validateDoc(json: unknown): ValidateDocResult {
  const checker = new Checker();
  checker.node(json, [], 0);
  if (checker.fileReferences > MAX_FILE_REFERENCES) checker.add([], DOC_MESSAGES.tooManyFiles);
  if (checker.problems.length > 0) return { ok: false, problems: checker.problems };

  let node: PMNode;
  try {
    node = schema.nodeFromJSON(json);
  } catch {
    return { ok: false, problems: [{ path: [], message: DOC_MESSAGES.notADoc }] };
  }
  checker.structure(node, []);
  if (checker.problems.length > 0) return { ok: false, problems: checker.problems };
  try {
    node.check();
  } catch {
    // Safety net: everything `check` tests is tested above with a path.
    return { ok: false, problems: [{ path: [], message: DOC_MESSAGES.notADoc }] };
  }
  return { ok: true, doc: nodeJSON(node) };
}
