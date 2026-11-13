/**
 * Markdown input rules (SPEC-013 §3.5 "Markdown input rules"). Each rule names its node or mark
 * by schema name, so it is a no-op if the schema ever lacks one. Mark rules need the closing
 * delimiter typed once and not before: `**x*` stays text until the second `*`, so bold and
 * italic never fire early on each other.
 */
import {
  Extension,
  InputRule,
  markInputRule,
  textblockTypeInputRule,
  wrappingInputRule,
} from '@tiptap/core';
import type { NodeType, Schema } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { isCodeLanguage } from './schema/links.js';
import { emojiShortcodeRule } from './emoji/autocomplete.js';

function nodeType(schema: Schema, name: string): NodeType | null {
  return schema.nodes[name] ?? null;
}

function levelOf(hashes: string | undefined): number {
  return Math.min(Math.max(hashes?.length ?? 1, 1), 4);
}

export const InputRules = Extension.create({
  name: 'surfaceInputRules',
  addInputRules() {
    const { schema } = this.editor;
    const rules: InputRule[] = [];
    const heading = nodeType(schema, 'heading');
    const bulletList = nodeType(schema, 'bulletList');
    const orderedList = nodeType(schema, 'orderedList');
    const taskItem = nodeType(schema, 'taskItem');
    const blockquote = nodeType(schema, 'blockquote');
    const codeBlock = nodeType(schema, 'codeBlock');
    const horizontalRule = nodeType(schema, 'horizontalRule');
    const paragraph = nodeType(schema, 'paragraph');

    if (heading) {
      rules.push(
        textblockTypeInputRule({
          find: /^(#{1,4})\s$/,
          type: heading,
          getAttributes: (match) => ({ level: levelOf(match[1]) }),
        }),
      );
    }
    if (bulletList) rules.push(wrappingInputRule({ find: /^\s*[-+*]\s$/, type: bulletList }));
    if (orderedList) rules.push(wrappingInputRule({ find: /^1\.\s$/, type: orderedList }));
    if (taskItem) {
      rules.push(
        wrappingInputRule({
          find: /^\s*\[([ xX])?\]\s$/,
          type: taskItem,
          getAttributes: (match) => ({ checked: match[1] === 'x' || match[1] === 'X' }),
        }),
      );
    }
    if (blockquote) rules.push(wrappingInputRule({ find: /^\s*>\s$/, type: blockquote }));
    if (codeBlock) {
      rules.push(
        textblockTypeInputRule({
          find: /^```([A-Za-z0-9_+#.-]*)[\s\n]$/,
          type: codeBlock,
          getAttributes: (match) => {
            const language = match[1] ?? '';
            return { language: language !== '' && isCodeLanguage(language) ? language : null };
          },
        }),
      );
    }
    if (horizontalRule && paragraph) {
      rules.push(
        new InputRule({
          find: /^(?:\*\*\*|---)\s$/,
          handler: ({ state, range }) => {
            const { tr } = state;
            tr.replaceRangeWith(range.from, range.to, horizontalRule.create());
            const after = tr.mapping.map(range.to);
            // A divider at the very end needs a paragraph after it to keep typing in.
            if (tr.doc.resolve(Math.min(after, tr.doc.content.size)).nodeAfter === null) {
              tr.insert(after, paragraph.create());
            }
            const cursor = Math.min(after + 1, tr.doc.content.size);
            tr.setSelection(TextSelection.near(tr.doc.resolve(cursor)));
          },
        }),
      );
    }

    const mark = (name: string, find: RegExp): void => {
      const type = schema.marks[name];
      if (type) rules.push(markInputRule({ find, type }));
    };
    mark('bold', /(?:^|\s)\*\*(?!\s)([^*]+)\*\*$/);
    mark('italic', /(?:^|\s)\*(?!\s)([^*]+)\*$/);
    mark('italic', /(?:^|\s)_(?!\s)([^_]+)_$/);
    mark('strike', /(?:^|\s)~~(?!\s)([^~]+)~~$/);
    mark('strike', /(?:^|\s)~(?!\s)([^~]+)~$/);
    mark('code', /(?:^|\s)`(?!\s)([^`]+)`$/);
    rules.push(emojiShortcodeRule());
    return rules;
  },
});
