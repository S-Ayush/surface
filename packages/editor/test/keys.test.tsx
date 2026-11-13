// @vitest-environment jsdom
// PLAN-013 S2: the web editor's keys and Markdown input rules (SPEC-013 §3.5, AC-23), and the web
// schema equals the headless schema (AC-9, second half).
import { DOC_SCHEMA_VERSION } from '@surface/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEmoji } from '../src/emoji/data.js';
import { schema } from '../src/schema/index.js';
import { attrNames, schemaHash } from './support/schema-hash.js';
import {
  destroyAll,
  docOf,
  makeEditor,
  paragraph,
  press,
  type,
  type Harness,
  type Key,
} from './support/web-editor.js';

afterEach(destroyAll);

const text = (value: string, ...marks: string[]) => ({
  type: 'text',
  text: value,
  ...(marks.length > 0 ? { marks: marks.map((mark) => ({ type: mark })) } : {}),
});

/** An editor holding `hello` with the whole word selected. */
function selected(): Harness {
  const harness = makeEditor({ content: docOf(paragraph('hello')) });
  harness.editor.commands.setTextSelection({ from: 1, to: 6 });
  return harness;
}

function firstBlock(harness: Harness) {
  return harness.json().content?.[0];
}

describe('the web schema equals the headless schema (AC-9)', () => {
  it('has the same node and mark names, attributes and schema hash', () => {
    const { editor } = makeEditor();
    expect(Object.keys(editor.schema.nodes)).toEqual(Object.keys(schema.nodes));
    expect(Object.keys(editor.schema.marks)).toEqual(Object.keys(schema.marks));
    for (const type of Object.values(schema.nodes)) {
      expect(attrNames(editor.schema.nodes[type.name]!)).toEqual(attrNames(type));
    }
    expect(DOC_SCHEMA_VERSION).toBe(1);
    expect(schemaHash(editor.schema)).toBe(schemaHash(schema));
  });
});

describe('formatting keys (AC-23)', () => {
  const MARKS: readonly (readonly [string, Key])[] = [
    ['bold', { key: 'b', ctrl: true }],
    ['italic', { key: 'i', ctrl: true }],
    ['underline', { key: 'u', ctrl: true }],
    ['strike', { key: 'X', code: 'KeyX', ctrl: true, shift: true }],
    ['code', { key: 'e', ctrl: true }],
  ];
  it.each(MARKS)('applies %s to the selection', (name, key) => {
    const harness = selected();
    press(harness.editor, key);
    expect(firstBlock(harness)).toEqual({ type: 'paragraph', content: [text('hello', name)] });
  });

  it('turns a selection into a block quote', () => {
    const harness = selected();
    press(harness.editor, { key: '>', code: 'Period', alt: true, shift: true });
    expect(firstBlock(harness)?.type).toBe('blockquote');
  });

  it.each([1, 2, 3, 4])('makes heading %i with Mod+Alt+%i, matched on the digit key', (level) => {
    const harness = selected();
    press(harness.editor, { key: 'º', code: `Digit${String(level)}`, ctrl: true, alt: true });
    expect(firstBlock(harness)).toMatchObject({ type: 'heading', attrs: { level } });
  });

  it('turns a heading back into regular text with Mod+Alt+0', () => {
    const harness = makeEditor({
      content: docOf({ type: 'heading', attrs: { level: 2 }, content: [text('hi')] }),
    });
    press(harness.editor, { key: '0', code: 'Digit0', ctrl: true, alt: true });
    expect(firstBlock(harness)?.type).toBe('paragraph');
  });

  const BLOCKS: readonly (readonly [string, string, string])[] = [
    ['checklist', 'Digit7', 'taskList'],
    ['bulleted list', 'Digit8', 'bulletList'],
    ['numbered list', 'Digit9', 'orderedList'],
  ];
  it.each(BLOCKS)('makes a %s with Mod+Shift+digit, matched on the code', (_name, code, node) => {
    const harness = selected();
    // `event.key` is the shifted symbol on a US layout and something else on others.
    press(harness.editor, { key: '&', code, ctrl: true, shift: true });
    expect(firstBlock(harness)?.type).toBe(node);
  });

  it('makes a code block with Mod+Shift+Backslash', () => {
    const harness = selected();
    press(harness.editor, { key: '|', code: 'Backslash', ctrl: true, shift: true });
    expect(firstBlock(harness)?.type).toBe('codeBlock');
  });

  it('moves a block down and up with Alt+Arrow', () => {
    const harness = makeEditor({ content: docOf(paragraph('one'), paragraph('two')) });
    harness.editor.commands.setTextSelection(2);
    press(harness.editor, { key: 'ArrowDown', code: 'ArrowDown', alt: true });
    expect(harness.json().content).toEqual([paragraph('two'), paragraph('one')]);
    press(harness.editor, { key: 'ArrowUp', code: 'ArrowUp', alt: true });
    expect(harness.json().content).toEqual([paragraph('one'), paragraph('two')]);
  });

  it('undoes and redoes with Mod+Z and Mod+Shift+Z', () => {
    const harness = makeEditor({ content: docOf(paragraph('a')) });
    harness.editor.commands.setTextSelection(2);
    type(harness.editor, 'b');
    expect(harness.json().content).toEqual([paragraph('ab')]);
    press(harness.editor, { key: 'z', ctrl: true });
    expect(harness.json().content).toEqual([paragraph('a')]);
    press(harness.editor, { key: 'Z', ctrl: true, shift: true });
    expect(harness.json().content).toEqual([paragraph('ab')]);
  });

  it('opens the link field with Mod+K on a text selection', () => {
    const harness = selected();
    const event = press(harness.editor, { key: 'k', ctrl: true });
    expect(harness.openLink).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves Mod+K alone without a selection, so the command menu opens', () => {
    const harness = makeEditor({ content: docOf(paragraph('hello')) });
    const event = press(harness.editor, { key: 'k', ctrl: true });
    expect(harness.openLink).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('Markdown input rules (AC-23)', () => {
  function typed(input: string): Harness {
    const harness = makeEditor();
    harness.editor.commands.focus();
    type(harness.editor, input);
    return harness;
  }

  it.each([
    ['# ', 1],
    ['## ', 2],
    ['### ', 3],
    ['#### ', 4],
  ])('"%s" starts heading %i', (input, level) => {
    expect(firstBlock(typed(input))).toMatchObject({ type: 'heading', attrs: { level } });
  });

  it.each([
    ['- ', 'bulletList'],
    ['* ', 'bulletList'],
    ['+ ', 'bulletList'],
    ['1. ', 'orderedList'],
    ['[] ', 'taskList'],
    ['[ ] ', 'taskList'],
    ['> ', 'blockquote'],
    ['--- ', 'horizontalRule'],
    ['*** ', 'horizontalRule'],
  ])('"%s" starts a %s', (input, node) => {
    expect(firstBlock(typed(input))?.type).toBe(node);
  });

  it('starts a code block with its language from a fence', () => {
    expect(firstBlock(typed('```typescript '))).toMatchObject({
      type: 'codeBlock',
      attrs: { language: 'typescript' },
    });
  });

  it.each([
    ['say **hi**', 'bold'],
    ['say *hi*', 'italic'],
    ['say _hi_', 'italic'],
    ['say ~hi~', 'strike'],
    ['say ~~hi~~', 'strike'],
    ['say `hi`', 'code'],
  ])('"%s" marks the word as %s', (input, mark) => {
    expect(firstBlock(typed(input))).toEqual({
      type: 'paragraph',
      content: [text('say '), text('hi', mark)],
    });
  });

  it('does not fire bold early on the first star of a closing pair', () => {
    expect(firstBlock(typed('**hi*'))).toEqual(paragraph('**hi*'));
  });

  it('turns :name: into the emoji once the data is loaded', async () => {
    await loadEmoji();
    expect(firstBlock(typed('good :thumbsup:'))).toEqual(paragraph('good 👍'));
  });
});

describe('Enter exits blocks (AC-23)', () => {
  it('leaves a code block on the second Enter at an empty last line', () => {
    const harness = makeEditor({
      mode: 'description',
      content: docOf({ type: 'codeBlock', content: [text('x')] }),
    });
    harness.editor.commands.focus('end');
    press(harness.editor, { key: 'Enter' });
    expect(harness.json().content?.[0]).toMatchObject({
      type: 'codeBlock',
      content: [text('x\n')],
    });
    press(harness.editor, { key: 'Enter' });
    expect(harness.json().content).toEqual([
      { type: 'codeBlock', attrs: { language: null }, content: [text('x')] },
      { type: 'paragraph' },
    ]);
  });

  it('leaves a block quote on the second Enter', () => {
    const harness = makeEditor({
      mode: 'description',
      content: docOf({ type: 'blockquote', content: [paragraph('q')] }),
    });
    harness.editor.commands.focus('end');
    press(harness.editor, { key: 'Enter' });
    press(harness.editor, { key: 'Enter' });
    expect(harness.json().content?.map((node) => node.type)).toEqual(['blockquote', 'paragraph']);
  });

  it('leaves a list on the second Enter', () => {
    const harness = makeEditor({
      mode: 'description',
      content: docOf({
        type: 'bulletList',
        content: [{ type: 'listItem', content: [paragraph('a')] }],
      }),
    });
    harness.editor.commands.focus('end');
    press(harness.editor, { key: 'Enter' });
    press(harness.editor, { key: 'Enter' });
    expect(harness.json().content?.map((node) => node.type)).toEqual(['bulletList', 'paragraph']);
  });
});
