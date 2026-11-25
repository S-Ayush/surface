/**
 * @vitest-environment jsdom
 */
// PLAN-016 S8 (design-system §4 "Empty states"): an icon, one sentence, a primary action, and the
// shortcut as a Kbd whose spoken text a screen reader hears.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from '../src/components/Button/Button.js';
import { EmptyState } from '../src/components/EmptyState/EmptyState.js';
import { Kbd } from '../src/components/Kbd/Kbd.js';
import { PlatformProvider } from '../src/platform.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

function mount(node: React.ReactElement): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(<PlatformProvider platform="mac">{node}</PlatformProvider>));
  return host;
}

describe('EmptyState', () => {
  it('the shortcut renders as a kbd with spoken text', () => {
    const el = mount(
      <EmptyState
        icon={<svg />}
        title="No issues in ENG yet"
        description={
          <>
            Create one with <Kbd keys="C" />
          </>
        }
      />,
    );
    const kbd = el.querySelector('p kbd');
    expect(kbd).not.toBeNull();
    // Spoken text is real text, not an aria-label.
    expect(kbd?.hasAttribute('aria-label')).toBe(false);
    expect(kbd?.textContent).toContain('C');
    expect(el.textContent).toContain('Create one with ');
  });

  it('the primary action runs and shows its shortcut', () => {
    const onClick = vi.fn();
    const el = mount(
      <EmptyState
        icon={<svg />}
        title="No issues in ENG yet"
        action={
          <Button variant="primary" shortcut="C" onClick={onClick}>
            Create issue
          </Button>
        }
      />,
    );
    const button = el.querySelector('button');
    expect(button?.textContent).toContain('Create issue');
    expect(button?.querySelector('kbd')).not.toBeNull();
    expect(button?.getAttribute('aria-keyshortcuts')).toBe('C');
    act(() => button?.click());
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('keeps the icon decorative', () => {
    const el = mount(<EmptyState icon={<svg />} title="Nothing here" />);
    expect(el.querySelector('svg')?.parentElement?.getAttribute('aria-hidden')).toBe('true');
  });
});
