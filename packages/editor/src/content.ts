import type { DocNodeJSON } from '@surface/domain';
import type { JSONContent } from '@tiptap/core';

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
