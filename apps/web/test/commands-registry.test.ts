import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from '../src/commands/registry.js';
import { ScopeStack } from '../src/shortcuts/ShortcutProvider.js';

describe('CommandRegistry', () => {
  it('is unavailable without a handler, and runs the newest handler', () => {
    const registry = new CommandRegistry(() => undefined);
    expect(registry.isAvailable('toggle:theme')).toBe(false);
    expect(registry.run('toggle:theme')).toBe(false);
    const global = vi.fn();
    const page = vi.fn();
    registry.register('toggle:theme', { run: global });
    const unregister = registry.register('toggle:theme', { run: page });
    registry.run('toggle:theme');
    unregister();
    registry.run('toggle:theme');
    expect(page).toHaveBeenCalledOnce();
    expect(global).toHaveBeenCalledOnce();
  });

  it('ranks by level, not mount order: a page beats the shell even if it registered first', () => {
    const registry = new CommandRegistry(() => undefined);
    const page = vi.fn();
    const shell = vi.fn();
    const dialog = vi.fn();
    // React runs a child's effects before its parent's: the page registers first on a deep link.
    const unregisterPage = registry.register('ui:escape', { run: page }, 'page');
    registry.register('ui:escape', { run: shell });
    registry.run('ui:escape');
    expect(page).toHaveBeenCalledOnce();
    expect(shell).not.toHaveBeenCalled();

    const unregisterDialog = registry.register('ui:escape', { run: dialog }, 'overlay');
    registry.run('ui:escape');
    expect(dialog).toHaveBeenCalledOnce();
    unregisterDialog();
    unregisterPage();
    registry.run('ui:escape');
    expect(shell).toHaveBeenCalledOnce();
  });

  it('honours `when`', () => {
    const registry = new CommandRegistry(() => undefined);
    let allowed = false;
    const run = vi.fn();
    registry.register('nav:settings', { run, when: () => allowed });
    expect(registry.run('nav:settings')).toBe(false);
    allowed = true;
    expect(registry.isAvailable('nav:settings')).toBe(true);
    expect(registry.run('nav:settings')).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it('reports thrown and rejected failures', async () => {
    const errors: unknown[] = [];
    const registry = new CommandRegistry((error) => errors.push(error));
    registry.register('nav:settings', {
      run: () => {
        throw new Error('sync');
      },
    });
    registry.register('toggle:theme', { run: () => Promise.reject(new Error('async')) });
    registry.run('nav:settings');
    registry.run('toggle:theme');
    await vi.waitFor(() => expect(errors).toHaveLength(2));
  });
});

describe('ScopeStack', () => {
  it('lists page scopes newest first and drops them on unmount', () => {
    const stack = new ScopeStack();
    const popInbox = stack.push('inbox');
    stack.push('triage');
    expect(stack.current()).toEqual(['triage', 'inbox']);
    popInbox();
    expect(stack.current()).toEqual(['triage']);
  });
});
