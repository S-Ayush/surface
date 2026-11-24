// @vitest-environment jsdom
// The host's `value` shown in the editor (`showValue`, PLAN-014 S4b review). A description saved
// with another issue's image is stored pointing at this issue's copy (SPEC-014 §4.3), and the
// saver hands the editor the copy's id: only that attribute changes, in place, so the cursor, the
// text typed since and the undo history stay. Anything else still replaces the content.
import type { DocNodeJSON } from '@surface/domain';
import { undo } from '@tiptap/pm/history';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showValue } from '../src/content.js';
import { destroyAll, docOf, makeEditor, paragraph, type } from './support/web-editor.js';

afterEach(destroyAll);

const SOURCE = '01940000-0000-7000-8000-00000000000a';
const COPY = '01940000-0000-7000-8000-0000000000aa';

/** The editor's own JSON with every `src` naming `from` pointed at `to`. */
function renamed(json: DocNodeJSON, from: string, to: string): DocNodeJSON {
  return JSON.parse(
    JSON.stringify(json).replaceAll(`/files/${from}`, `/files/${to}`),
  ) as DocNodeJSON;
}

function withImage() {
  const harness = makeEditor({
    mode: 'description',
    content: docOf(paragraph('Pasted'), {
      type: 'image',
      attrs: { src: `/files/${SOURCE}`, alt: null },
    }),
  });
  // The cursor after "Past"; the user typed there after the save went out.
  harness.editor.commands.setTextSelection(5);
  type(harness.editor, 'X');
  return harness;
}

describe('showValue', () => {
  it('renames a file in place: the selection and the text typed since stay', () => {
    const h = withImage();
    const { editor } = h;
    const before = h.json();
    const { from, to } = editor.state.selection;
    const updates = vi.fn();
    editor.on('update', updates);

    showValue(editor, renamed(before, SOURCE, COPY));

    expect(h.json()).toEqual(renamed(before, SOURCE, COPY));
    expect(editor.state.doc.textContent).toBe('PastXed');
    expect([editor.state.selection.from, editor.state.selection.to]).toEqual([from, to]);
    // The host's own value: no change event goes back to it.
    expect(updates).not.toHaveBeenCalled();
  });

  it('keeps the rename out of the undo history: undo takes back the typing, not the id', () => {
    const h = withImage();
    const { editor } = h;
    showValue(editor, renamed(h.json(), SOURCE, COPY));
    undo(editor.state, (tr) => {
      editor.view.dispatch(tr);
    });
    expect(editor.state.doc.textContent).toBe('Pasted');
    expect(JSON.stringify(h.json())).toContain(COPY);
    expect(JSON.stringify(h.json())).not.toContain(SOURCE);
  });

  it('replaces the content when more than file srcs differ', () => {
    const h = withImage();
    const { editor } = h;
    const other = docOf(paragraph('Someone else’s text'));
    showValue(editor, other);
    expect(h.json()).toEqual(other);
  });

  it('does nothing when the editor holds the value already', () => {
    const h = withImage();
    const { editor } = h;
    const doc = editor.state.doc;
    const transactions = vi.fn();
    editor.on('transaction', transactions);
    showValue(editor, h.json());
    expect(editor.state.doc).toBe(doc);
    expect(transactions).not.toHaveBeenCalled();
  });
});
