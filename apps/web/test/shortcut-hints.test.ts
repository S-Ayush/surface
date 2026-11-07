// The hint toasts: the sequence hint (shortcuts.md rule 3) and "not available here" (SPEC-005 §5).
import { afterEach, describe, expect, it } from 'vitest';
import { overlayManager } from '@surface/ui';
import { UNAVAILABLE_HINT_MS, toastHints } from '../src/shortcuts/ShortcutProvider.js';
import { SHORTCUTS } from '../src/shortcuts/registry.js';

const byId = (id: string) => {
  const found = SHORTCUTS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`No binding ${id}`);
  return found;
};
const shown = () => overlayManager.getSnapshot().visibleToasts;

afterEach(() => {
  overlayManager.clear();
});

describe('shortcut hints', () => {
  it('lists what can follow a sequence key, until cleared', () => {
    const hints = toastHints('mac');
    hints.sequence(['G'], [byId('nav.settings')]);
    expect(shown().map((t) => [t.message, t.duration])).toEqual([
      ['G… S: Go to settings', Infinity],
    ]);
    hints.clear();
    expect(shown()).toEqual([]);
  });

  it('says a command is not available here, briefly, and replaces the previous hint', () => {
    const hints = toastHints('other');
    hints.sequence(['O'], [byId('nav.openTeam')]);
    hints.unavailable(byId('global.commandMenu'));
    expect(shown().map((t) => [t.message, t.duration])).toEqual([
      ["Open command menu isn't available here", UNAVAILABLE_HINT_MS],
    ]);
  });

  it('stays quiet over an open overlay, where the toast would only appear after it closes', () => {
    const layer = overlayManager.pushLayer('modal');
    toastHints('mac').unavailable(byId('global.commandMenu'));
    overlayManager.removeLayer(layer);
    expect(shown()).toEqual([]);
    expect(overlayManager.getSnapshot().queuedToasts).toEqual([]);
  });
});
