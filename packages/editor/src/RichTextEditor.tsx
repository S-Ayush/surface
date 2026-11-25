/**
 * The rich text editor for descriptions and comments (SPEC-013 §3.5, §4.4). TipTap on the schema
 * of `schema/extensions.ts`; `value` and `onChange` are the stored document JSON. The host injects
 * uploads and decides what `Enter` does through `mode`.
 */
import { EMPTY_DOC, type DocNodeJSON } from '@surface/domain';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import type { HandlerRef } from './blockKeys.js';
import { BubbleMenu } from './bubbleMenu.js';
import { showValue, toContent } from './content.js';
import { applyEmoji } from './emoji/autocomplete.js';
import type { Emoji } from './emoji/data.js';
import { webEditorOptions, webExtensions } from './extensions.web.js';
import type { EditorMode, KeyHandlers } from './keymap.js';
import { nodeJSON } from './schema/schema.js';
import { validateDoc } from './schema/validate.js';
import { applySlash, type SlashItem } from './slash.js';
import { optionId, SuggestionList } from './slashMenu.js';
import type { SuggestionState } from './suggestion.js';
import {
  openFileChooser,
  uploadNotAvailable,
  type UploadedFile,
  type UploadFile,
} from './upload.js';
import './editor.css';

export interface RichTextEditorHandle {
  focus(): void;
  /** Opens the file chooser and inserts each file inline at the cursor (`Mod+Shift+U`, SPEC-012 §3.6). */
  openFileChooser(): void;
}

export interface RichTextEditorProps {
  readonly mode: EditorMode;
  /** The stored document. A change from outside replaces the content; `onChange` echoes are ignored. */
  readonly value: DocNodeJSON;
  readonly onChange?: (doc: DocNodeJSON) => void;
  /** Comment mode `Enter` (outside lists, quotes and code) calls it. `Mod+Enter` is never consumed. */
  readonly onSubmit?: () => void;
  readonly onBlur?: () => void;
  readonly placeholder?: string;
  readonly readOnly?: boolean;
  /** In a read-only editor, whether checklist items still toggle. */
  readonly checklistEditable?: boolean;
  /** Uploads a file and returns its `/files/<uuid>` source. Defaults to a refusal until PLAN-014 S5. */
  readonly onUploadFile?: (file: File) => Promise<UploadedFile>;
  /** Shows a sentence about a failed upload or paste (the host owns toasts). */
  readonly onError?: (message: string) => void;
  /** Focus on mount: at the start by default, or at `end`. */
  readonly autofocus?: boolean | 'start' | 'end';
  /** The accessible name of the text box. */
  readonly ariaLabel?: string;
  readonly ref?: Ref<RichTextEditorHandle>;
}

const SLASH_ID = 'surface-editor-slash';
const EMOJI_ID = 'surface-editor-emoji';

/**
 * An instance the effects may use. TipTap destroys the instance of an editor that is hidden or not
 * yet mounted after a tick (an `Activity`, a Suspense boundary revealing it later) and builds a new
 * one on the next render, so a reveal can re-run the effects with the destroyed one, whose
 * `commands` throws. Skipping it is enough: the next render brings the new instance.
 */
function live(editor: Editor | null): editor is Editor {
  return editor !== null && !editor.isDestroyed;
}

/** A usable document from `value`: an invalid one shows as empty rather than crashing. */
function contentOf(value: DocNodeJSON): DocNodeJSON {
  const result = validateDoc(value);
  return result.ok ? result.doc : EMPTY_DOC;
}

/**
 * What the extensions need from the host, which changes between renders while the extensions are
 * built once per editor. A plain object (not a ref) that `update` refreshes after every render.
 */
class Bridge implements HandlerRef {
  props: RichTextEditorProps;

  update(props: RichTextEditorProps): void {
    this.props = props;
  }

  readonly keys: KeyHandlers;
  #chooseFile: (kind: 'image' | 'file' | 'any') => void = () => undefined;

  setChooser(choose: (kind: 'image' | 'file' | 'any') => void): void {
    this.#chooseFile = choose;
  }

  chooseFile(kind: 'image' | 'file' | 'any'): void {
    this.#chooseFile(kind);
  }

  constructor(props: RichTextEditorProps, openLink: () => void) {
    this.props = props;
    this.keys = {
      mode: props.mode,
      onSubmit: () => {
        this.props.onSubmit?.();
      },
      openLink,
    };
  }

  get current(): KeyHandlers {
    return { ...this.keys, mode: this.props.mode };
  }

  upload = (): UploadFile => this.props.onUploadFile ?? uploadNotAvailable;
  onError = (): ((message: string) => void) => this.props.onError ?? (() => undefined);
}

export function RichTextEditor({ ref, ...props }: RichTextEditorProps) {
  const { mode, value, readOnly = false, autofocus = false } = props;
  const wrapper = useRef<HTMLDivElement | null>(null);
  const [linking, setLinking] = useState(false);
  const [slash, setSlash] = useState<SuggestionState<SlashItem> | null>(null);
  const [emoji, setEmoji] = useState<SuggestionState<Emoji> | null>(null);

  // The extensions are built once per editor; the host's callbacks reach them through the bridge.
  const [bridge] = useState(
    () =>
      new Bridge(props, () => {
        setLinking(true);
      }),
  );
  useLayoutEffect(() => {
    bridge.update(props);
  });

  const [extensions] = useState(() =>
    webExtensions({
      handlers: bridge,
      placeholder: props.placeholder ?? '',
      upload: bridge.upload,
      onError: bridge.onError,
      canToggle: (editable) => editable || bridge.props.checklistEditable === true,
      onSlash: setSlash,
      onEmoji: setEmoji,
      chooseFile: (kind) => {
        bridge.chooseFile(kind);
      },
    }),
  );

  const editor = useEditor({
    extensions,
    content: toContent(contentOf(value)),
    editable: !readOnly,
    autofocus,
    ...webEditorOptions,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': props.ariaLabel ?? (mode === 'comment' ? 'Comment' : 'Description'),
        class: 'surface-editor-content',
      },
    },
    onUpdate: ({ editor: updated }) => {
      bridge.props.onChange?.(nodeJSON(updated.state.doc));
    },
    onBlur: ({ event }) => {
      // Moving into the link field or a menu is not leaving the editor.
      const next = event.relatedTarget;
      if (next instanceof Node && wrapper.current?.contains(next) === true) return;
      bridge.props.onBlur?.();
    },
  });

  useEffect(() => {
    bridge.setChooser((kind) => {
      if (live(editor)) openFileChooser(editor, kind, bridge.upload(), bridge.onError());
    });
  }, [bridge, editor]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        if (live(editor)) editor.commands.focus('end');
      },
      openFileChooser: () => {
        bridge.chooseFile('any');
      },
    }),
    [bridge, editor],
  );

  useEffect(() => {
    if (live(editor)) editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  // A `value` that differs from what the editor holds replaces it (a sync, a discard, a reset),
  // or, when only file srcs differ, renames them in place (`showValue`).
  useEffect(() => {
    if (!live(editor)) return;
    showValue(editor, contentOf(value));
  }, [editor, value]);

  // Name the highlighted option for screen readers. The editor is a `textbox`, which allows
  // `aria-activedescendant` and `aria-controls` but not `aria-expanded` (axe aria-allowed-attr).
  const activeSlash =
    slash !== null && slash.items.length > 0 ? optionId(SLASH_ID, slash.index) : null;
  const activeEmoji =
    emoji !== null && emoji.items.length > 0 ? optionId(EMOJI_ID, emoji.index) : null;
  const active = activeSlash ?? activeEmoji;
  const listId = activeSlash !== null ? SLASH_ID : activeEmoji !== null ? EMOJI_ID : null;
  useEffect(() => {
    if (!live(editor)) return;
    const dom = editor.view.dom;
    if (active === null || listId === null) {
      dom.removeAttribute('aria-activedescendant');
      dom.removeAttribute('aria-controls');
    } else {
      dom.setAttribute('aria-activedescendant', active);
      dom.setAttribute('aria-controls', listId);
    }
  }, [editor, active, listId]);

  if (editor === null) return null;
  return (
    <div ref={wrapper} className="surface-editor" data-mode={mode} data-readonly={readOnly}>
      <EditorContent editor={editor} />
      <BubbleMenu editor={editor} linking={linking} onLinking={setLinking} />
      <SuggestionList
        id={SLASH_ID}
        label="Insert"
        state={slash}
        itemKey={(item) => item.id}
        renderItem={(item) => item.label}
        onPick={(item, match) => {
          applySlash(editor, match, item, (kind) => {
            bridge.chooseFile(kind);
          });
        }}
      />
      <SuggestionList
        id={EMOJI_ID}
        label="Emoji"
        state={emoji}
        itemKey={(item) => item.unicode}
        renderItem={(item) => (
          <>
            <span aria-hidden="true">{item.unicode}</span>{' '}
            <span>{item.shortcodes[0] ?? item.label}</span>
          </>
        )}
        onPick={(item, match) => {
          applyEmoji(editor, match, item);
        }}
      />
    </div>
  );
}
