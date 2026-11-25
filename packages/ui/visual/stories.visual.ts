// AC-13: visual snapshot of every M0 component story in both themes (design-system §5.4).
import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';

type Story = { id: string; tags: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Stories from Storybook's index.json, validated (it is build output, not our code). */
function readStories(): Story[] {
  const index: unknown = JSON.parse(
    readFileSync(new URL('../dist/storybook/index.json', import.meta.url), 'utf8'),
  );
  if (!isRecord(index) || !isRecord(index['entries'])) throw new Error('Unexpected index.json');
  return Object.values(index['entries']).flatMap((entry) => {
    if (!isRecord(entry) || entry['type'] !== 'story' || typeof entry['id'] !== 'string') return [];
    const tags = Array.isArray(entry['tags'])
      ? entry['tags'].filter((t) => typeof t === 'string')
      : [];
    return [{ id: entry['id'], tags }];
  });
}

// Stories with a play function change the page (typing, focus) and are covered by the Storybook
// tests; their components also have a static story that is snapshotted here.
const stories = readStories().filter((story) => !story.tags.includes('play-fn'));

test('every component has at least one snapshotted (static) story', () => {
  const components = readdirSync(new URL('../src/components/', import.meta.url));
  // Any story group counts (Primitives, Overlays, Domain, Brand): the group is a catalogue choice,
  // not a reason to skip the snapshot. A folder may also be the group itself (Brand/SurfaceMark).
  const missing = components.filter((name) => {
    const id = name.toLowerCase();
    return !stories.some((story) =>
      new RegExp(`^([a-z0-9]+-${id}|${id}-[a-z0-9-]+)--`).test(story.id),
    );
  });
  expect(missing).toEqual([]);
});

for (const story of stories) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${story.id} (${theme})`, async ({ page }) => {
      await page.goto(`/iframe.html?id=${story.id}&viewMode=story&globals=theme:${theme}`);
      // Rendered: the root holds the story and the (empty) toast region, committed together with
      // any portals. Overlay stories render into portals, so nothing in the root need be visible.
      await page.locator('#storybook-root > *').first().waitFor({ state: 'attached' });
      await page.waitForFunction(() => document.fonts.status === 'loaded');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page).toHaveScreenshot(`${story.id}--${theme}.png`, { fullPage: true });
    });
  }
}
