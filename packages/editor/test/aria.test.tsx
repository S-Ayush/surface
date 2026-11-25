// @vitest-environment jsdom
// The editor is a `textbox`, so it carries only ARIA that role allows (axe `aria-allowed-attr`):
// no `aria-expanded`. While the slash list is open, `aria-activedescendant` and `aria-controls`
// name the highlighted option (SPEC-013 §3.5).
import { EMPTY_DOC } from '@surface/domain';
import { Editor } from '@tiptap/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RichTextEditor } from '../src/RichTextEditor.js';
import { type } from './support/web-editor.js';
import './support/layout.js';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <RichTextEditor mode="description" value={EMPTY_DOC} onChange={() => undefined} />,
    );
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.useRealTimers();
});

function textbox(): HTMLElement {
  const dom = container?.querySelector('[role="textbox"]');
  if (!(dom instanceof HTMLElement)) throw new Error('expected the editor textbox');
  return dom;
}

function typeInto(text: string): void {
  const editor: unknown = Reflect.get(textbox(), 'editor');
  if (!(editor instanceof Editor)) throw new Error('expected the TipTap editor on the textbox');
  act(() => {
    editor.commands.focus();
    type(editor, text);
    vi.advanceTimersByTime(10);
  });
}

describe('editor ARIA', () => {
  it('never sets aria-expanded on the textbox, closed or with the slash list open', () => {
    expect(textbox().hasAttribute('aria-expanded')).toBe(false);
    typeInto('/');
    expect(textbox().getAttribute('aria-activedescendant')).not.toBeNull();
    expect(textbox().hasAttribute('aria-expanded')).toBe(false);
  });

  it('points aria-activedescendant and aria-controls at the open list, and clears them on close', () => {
    typeInto('/');
    const active = textbox().getAttribute('aria-activedescendant');
    const controls = textbox().getAttribute('aria-controls');
    expect(controls).toBe('surface-editor-slash');
    expect(document.getElementById(active ?? '')?.getAttribute('role')).toBe('option');
    expect(document.getElementById(controls ?? '')).not.toBeNull();

    typeInto('zzz'); // no entry matches, so the list closes
    expect(textbox().hasAttribute('aria-activedescendant')).toBe(false);
    expect(textbox().hasAttribute('aria-controls')).toBe(false);
  });
});
