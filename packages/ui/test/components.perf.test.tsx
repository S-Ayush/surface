// Render cost of the S2 primitives (design-system §5.4: < 1 ms per instance). A wall-clock budget,
// so it runs in `pnpm test:deep`, not the gate (plans README §6); the markup itself is checked in
// `components.test.tsx`.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Avatar } from '../src/components/Avatar/Avatar.js';
import { Badge } from '../src/components/Badge/Badge.js';
import { Button } from '../src/components/Button/Button.js';
import { Kbd } from '../src/components/Kbd/Kbd.js';

describe('render cost (design-system §5.4: < 1 ms per instance)', () => {
  const N = 500;
  it.each([
    ['Avatar', () => <Avatar name="Ada Lovelace" />],
    ['Badge', () => <Badge count={12} />],
    ['Kbd', () => <Kbd keys="Mod+K" />],
    ['Button', () => <Button shortcut="C">Create issue</Button>],
  ] as const)('%s renders well under 1 ms per instance', (_, make) => {
    const batch = (
      <>
        {Array.from({ length: N }, (_, i) => (
          <span key={i}>{make()}</span>
        ))}
      </>
    );
    renderToStaticMarkup(batch); // warm up
    // Best of three, so scheduling noise on a busy CI runner does not fail the check.
    const perInstance = Array.from({ length: 3 }, () => {
      const start = performance.now();
      renderToStaticMarkup(batch);
      return (performance.now() - start) / N;
    });
    expect(Math.min(...perInstance)).toBeLessThan(1);
  });
});
