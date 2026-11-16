// @vitest-environment jsdom
// The editor survives being hidden and shown again. React keeps a hidden subtree (an `Activity`, or
// a Suspense boundary showing its fallback) and re-runs its effects when it shows again. TipTap
// destroys the instance of a hidden editor after a tick and builds a new one on the next render,
// so for one commit the effects still hold the destroyed instance, whose `commands` throws.
import type { DocNodeJSON } from '@surface/domain';
import { Activity, act, createRef, StrictMode, type Ref } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RichTextEditor, type RichTextEditorHandle } from '../src/RichTextEditor.js';
import './support/layout.js';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const doc = (text: string): DocNodeJSON => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

let root: Root | null = null;
let container: HTMLElement | null = null;
const errors: unknown[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  errors.length = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container, {
    onUncaughtError: (error) => errors.push(error),
    onCaughtError: (error) => errors.push(error),
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

function render(mode: 'visible' | 'hidden', value: DocNodeJSON, ref?: Ref<RichTextEditorHandle>) {
  act(() => {
    root?.render(
      <StrictMode>
        <Activity mode={mode}>
          <RichTextEditor mode="description" value={value} onChange={() => undefined} ref={ref} />
        </Activity>
      </StrictMode>,
    );
  });
}

describe('an editor hidden and shown again', () => {
  it('does not use the destroyed instance, and shows its content again', () => {
    render('visible', doc('first'));
    expect(container?.textContent).toContain('first');

    render('hidden', doc('first'));
    // TipTap destroys a hidden editor after a tick.
    act(() => {
      vi.advanceTimersByTime(10);
    });

    // Shown again with a new value: the effects that sync `value` and `readOnly` run before the
    // new instance exists.
    render('visible', doc('second'));
    act(() => {
      vi.advanceTimersByTime(10);
    });

    expect(errors).toEqual([]);
    expect(container?.textContent).toContain('second');
  });

  it('first rendered hidden (a Suspense boundary revealing it later) mounts when shown', () => {
    // The instance is built during render; with no effects run within a tick, TipTap destroys it.
    render('hidden', doc('first'));
    act(() => {
      vi.advanceTimersByTime(10);
    });
    render('visible', doc('first'));
    act(() => {
      vi.advanceTimersByTime(10);
    });

    expect(errors).toEqual([]);
    expect(container?.textContent).toContain('first');
  });

  it('syncs a new value without touching an instance destroyed under it', () => {
    // In the app the destroyed instance stays the hook's snapshot while a hidden subtree waits at
    // idle priority, and the reveal re-runs the effects with it (`act` flushes too eagerly for
    // that, so destroy it directly). The `value` effect then called `editor.commands`.
    render('visible', doc('first'));
    const dom: unknown = container?.querySelector('.ProseMirror');
    const instance: unknown = dom instanceof HTMLElement ? Reflect.get(dom, 'editor') : undefined;
    const destroy: unknown =
      typeof instance === 'object' && instance !== null
        ? Reflect.get(instance, 'destroy')
        : undefined;
    expect(typeof destroy).toBe('function');
    if (typeof destroy === 'function') Reflect.apply(destroy, instance, []);

    render('visible', doc('second'));

    expect(errors).toEqual([]);
  });

  it('ignores focus() on a destroyed instance', () => {
    const ref = createRef<RichTextEditorHandle>();
    render('visible', doc('first'), ref);
    const handle = ref.current;
    render('hidden', doc('first'), ref);
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(() => handle?.focus()).not.toThrow();
  });
});
