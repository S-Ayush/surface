// Shared nested pages (command-menu.md §3.2).
import { HUE_NAMES, LABEL_HUES, type LabelHue } from '@surface/ui';
import type { CommandPage } from './model.js';

/** The 12-hue palette as a page ("Change team color…", AC-4). */
export function colorPage(
  title: string,
  choose: (hue: LabelHue) => void | Promise<void>,
): CommandPage {
  return {
    title,
    placeholder: 'Search colors…',
    items: () =>
      LABEL_HUES.map((hue) => ({
        id: `hue:${hue}`,
        title: HUE_NAMES[hue],
        hue,
        run: () => choose(hue),
      })),
  };
}
