/**
 * The web editor's extensions (SPEC-013 §4.4, AC-9). The document schema is exactly the headless
 * `SCHEMA_EXTENSIONS` of `schema/extensions.ts`: this file only `.extend()`s them (the task item
 * gets a checkbox view) and adds behaviour (keys, input rules, paste, menus, highlighting). It
 * adds no node, mark or attribute, and `test/keys.test.tsx` compares the two schemas.
 */
import type { AnyExtension, Extension } from '@tiptap/core';
import { Placeholder, UndoRedo } from '@tiptap/extensions';
import { CodeHighlight } from './codeHighlight.js';
import { applyEmoji, matchEmojiTrigger, searchEmoji } from './emoji/autocomplete.js';
import { loadEmoji, type Emoji } from './emoji/data.js';
import { InputRules } from './inputRules.js';
import { blockKeys, formattingKeys, type HandlerRef } from './blockKeys.js';
import { CoreKeymap } from './keymap.js';
import { pasteExtension } from './paste.js';
import { SCHEMA_EXTENSIONS, TaskItem } from './schema/extensions.js';
import { applySlash, matchSlashTrigger, slashItems, type SlashItem } from './slash.js';
import { suggestionExtension, type SuggestionState } from './suggestion.js';
import type { UploadFile } from './upload.js';

export interface WebExtensionOptions {
  readonly handlers: HandlerRef;
  readonly placeholder: string;
  readonly upload: () => UploadFile;
  readonly onError: () => (message: string) => void;
  /** Whether a checkbox click may toggle (always while editable; else `checklistEditable`). */
  readonly canToggle: (editable: boolean) => boolean;
  readonly onSlash: (state: SuggestionState<SlashItem> | null) => void;
  readonly onEmoji: (state: SuggestionState<Emoji> | null) => void;
  /** Opens the file chooser for the slash menu's Image and File entries. */
  readonly chooseFile: (kind: 'image' | 'file') => void;
}

/** The task item with a checkbox. Same name, content and attributes as the headless one. */
function webTaskItem(options: WebExtensionOptions): AnyExtension {
  return TaskItem.extend({
    addNodeView() {
      return ({ node, getPos, editor }) => {
        const dom = document.createElement('li');
        dom.setAttribute('data-type', 'taskItem');
        const label = document.createElement('label');
        label.contentEditable = 'false';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.setAttribute('aria-label', 'Checklist item');
        label.append(input);
        const content = document.createElement('div');
        dom.append(label, content);
        const show = (checked: boolean) => {
          dom.setAttribute('data-checked', checked ? 'true' : 'false');
          input.checked = checked;
          input.disabled = !options.canToggle(editor.isEditable);
        };
        show(node.attrs['checked'] === true);
        input.addEventListener('change', () => {
          const pos = getPos();
          if (pos === undefined || !options.canToggle(editor.isEditable)) {
            input.checked = !input.checked;
            return;
          }
          const checked = input.checked;
          editor.view.dispatch(
            editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked }),
          );
        });
        return {
          dom,
          contentDOM: content,
          update: (updated) => {
            if (updated.type !== node.type) return false;
            show(updated.attrs['checked'] === true);
            return true;
          },
        };
      };
    },
  });
}

/**
 * Options every web editor instance uses. `injectCSS: false` keeps TipTap from adding a `<style>`
 * tag (the CSP is `style-src 'self'`; the styles are in `editor.css`). The core keymap is replaced
 * by `CoreKeymap` so `Mod+Enter` stays unhandled (`keymap.ts`).
 */
export const webEditorOptions = {
  injectCSS: false,
  enableCoreExtensions: { keymap: false },
} as const;

export function webExtensions(options: WebExtensionOptions): AnyExtension[] {
  const schemaExtensions: AnyExtension[] = SCHEMA_EXTENSIONS.map((extension) =>
    extension.name === 'taskItem' ? webTaskItem(options) : extension,
  );
  const slash: Extension = suggestionExtension<SlashItem>({
    name: 'slashSuggestion',
    match: matchSlashTrigger,
    items: (query) => slashItems(query),
    select: (editor, match, item) => {
      applySlash(editor, match, item, options.chooseFile);
    },
    onChange: options.onSlash,
  });
  const emoji: Extension = suggestionExtension<Emoji>({
    name: 'emojiSuggestion',
    match: matchEmojiTrigger,
    items: (query) => loadEmoji().then((all) => searchEmoji(all, query)),
    select: (editor, match, item) => {
      applyEmoji(editor, match, item);
    },
    onChange: options.onEmoji,
  });
  return [
    ...schemaExtensions,
    CoreKeymap,
    UndoRedo,
    Placeholder.configure({ placeholder: options.placeholder }),
    InputRules,
    CodeHighlight,
    formattingKeys(options.handlers),
    blockKeys(options.handlers),
    pasteExtension({ upload: options.upload, onError: options.onError }),
    slash,
    emoji,
  ];
}
