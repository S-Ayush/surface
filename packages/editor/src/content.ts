import type { DocNodeJSON } from '@surface/domain';
import type { Editor, JSONContent } from '@tiptap/core';
import { fileSrcRenames } from './schema/files.js';
import { fileIdOfSrc, fileSrc } from './schema/links.js';
import { nodeJSON } from './schema/schema.js';

/** TipTap's content type wants mutable arrays: this copies the readonly document JSON into it. */
export function toContent(node: DocNodeJSON): JSONContent {
  const out: JSONContent = { type: node.type };
  if (node.attrs !== undefined) out.attrs = { ...node.attrs };
  if (node.text !== undefined) out.text = node.text;
  if (node.content !== undefined) out.content = node.content.map(toContent);
  if (node.marks !== undefined) {
    out.marks = node.marks.map((mark) =>
      mark.attrs === undefined
        ? { type: mark.type }
        : { type: mark.type, attrs: { ...mark.attrs } },
    );
  }
  return out;
}

/**
 * Shows the host's `value` (a valid document) in `editor`: nothing when it holds it already. When
 * only file srcs differ (a save stored pointing at this issue's copies, SPEC-014 §4.3), those
 * attributes change in place, outside the undo history, so the selection and anything typed since
 * stay. Otherwise the content is replaced (a sync, a discard, a reset).
 */
export function showValue(editor: Editor, value: DocNodeJSON): void {
  // The editor's own schema: the headless `schema`'s node types are other objects, so a node of
  // it never `eq`s the editor's.
  if (editor.schema.nodeFromJSON(value).eq(editor.state.doc)) return;
  const renamed = fileSrcRenames(nodeJSON(editor.state.doc), value);
  if (renamed === undefined || renamed.size === 0) {
    editor.commands.setContent(toContent(value), { emitUpdate: false });
    return;
  }
  const { tr } = editor.state;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'image' && node.type.name !== 'file') return;
    const src: unknown = node.attrs['src'];
    const id = typeof src === 'string' ? fileIdOfSrc(src) : null;
    const to = id === null ? undefined : renamed.get(id);
    // An attribute step: no position moves, so the selection maps to itself.
    if (to !== undefined) tr.setNodeAttribute(pos, 'src', fileSrc(to));
  });
  tr.setMeta('addToHistory', false).setMeta('preventUpdate', true);
  editor.view.dispatch(tr);
}
