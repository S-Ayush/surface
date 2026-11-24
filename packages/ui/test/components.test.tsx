// Pure helpers and server-rendered markup of the S2 primitives (PLAN-005 S2). Interaction and axe
// checks run in the browser (`pnpm test:storybook`); visuals in `pnpm test:visual`.
import { readdirSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Avatar, AvatarGroup, avatarHue, initials } from '../src/components/Avatar/Avatar.js';
import { Badge } from '../src/components/Badge/Badge.js';
import { Button } from '../src/components/Button/Button.js';
import { Input } from '../src/components/Input/Input.js';
import { Kbd } from '../src/components/Kbd/Kbd.js';
import { PlatformProvider } from '../src/platform.js';
import { LABEL_HUES } from '../src/tokens.gen.js';

const COMPONENTS_DIR = new URL('../src/components/', import.meta.url);

/** The S2 inventory (PLAN-005 S2), one directory each; AvatarGroup lives with Avatar. */
const S2_COMPONENTS = [
  'Avatar',
  'Badge',
  'Button',
  'Checkbox',
  'ColorPicker',
  'EmptyState',
  'IconButton',
  'Input',
  'Kbd',
  'ProgressBar',
  'SegmentedControl',
  'Skeleton',
  'Spinner',
  'Switch',
  'Tabs',
  'Textarea',
  'Tooltip',
];

/** The S3 overlays (PLAN-005 S3); ContextMenu lives with Menu, sharing its entries. */
const S3_COMPONENTS = ['Banner', 'Dialog', 'Menu', 'Popover', 'Toast'];

describe('component inventory', () => {
  it('has every S2 and S3 component, each with stories (visual snapshots and story tests come from them)', () => {
    const dirs = readdirSync(COMPONENTS_DIR);
    for (const name of [...S2_COMPONENTS, ...S3_COMPONENTS]) {
      expect(dirs, name).toContain(name);
      expect(readdirSync(new URL(`${name}/`, COMPONENTS_DIR)), name).toContain(
        `${name}.stories.tsx`,
      );
    }
  });
});

describe('Avatar helpers', () => {
  it('takes the first and last initials', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('  grace   brewster murray hopper ')).toBe('GH');
    expect(initials('linus')).toBe('L');
    expect(initials('')).toBe('');
  });

  it('never splits a surrogate pair', () => {
    expect(initials('😀 Ada')).toBe('😀A');
    expect(initials('𝒜da')).toBe('𝒜');
  });

  it('sizes every avatar in a group, and the overflow chip, from the group', () => {
    const html = renderToStaticMarkup(
      <AvatarGroup aria-label="Assignees" size={32} max={1}>
        <Avatar name="Ada Lovelace" />
        <Avatar name="Grace Hopper" />
      </AvatarGroup>,
    );
    // The group and the shown avatar carry the 32 px class; nothing falls back to 24 px.
    expect(html.match(/_lg_/g)?.length).toBe(2);
    expect(html).not.toMatch(/_md_/);
  });

  it('gives a person the same palette hue every time', () => {
    expect(avatarHue('Ada Lovelace')).toBe(avatarHue('Ada Lovelace'));
    expect(LABEL_HUES).toContain(avatarHue('Ada Lovelace'));
    const hues = new Set(['Ada', 'Grace', 'Alan', 'Linus', 'Katherine', 'Margaret'].map(avatarHue));
    expect(hues.size).toBeGreaterThan(2);
  });

  it('names the image after the person, including presence', () => {
    const html = renderToStaticMarkup(<Avatar name="Ada Lovelace" online />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Ada Lovelace (online)"');
  });
});

describe('Badge', () => {
  it('caps large counts at the maximum', () => {
    expect(renderToStaticMarkup(<Badge count={7} />)).toContain('>7<');
    expect(renderToStaticMarkup(<Badge count={128} />)).toContain('>99+<');
    expect(renderToStaticMarkup(<Badge count={1000} max={999} />)).toContain('>999+<');
  });
});

describe('Button', () => {
  it('defaults to type="button" so it never submits a form by accident', () => {
    expect(renderToStaticMarkup(<Button>Save</Button>)).toContain('type="button"');
  });

  it('exposes its shortcut as aria-keyshortcuts and hides the hint from the accessible name', () => {
    const html = renderToStaticMarkup(
      <PlatformProvider platform="mac">
        <Button shortcut="Mod+Enter">Create</Button>
      </PlatformProvider>,
    );
    expect(html).toContain('aria-keyshortcuts="Meta+Enter"');
    expect(html).toMatch(/<kbd[^>]*aria-hidden="true"/);
  });

  it('marks a loading button busy and keeps it enabled for focus', () => {
    const html = renderToStaticMarkup(<Button loading>Save</Button>);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('disabled');
  });
});

describe('Input', () => {
  it('links the label and the error message to the input', () => {
    const html = renderToStaticMarkup(<Input id="key" label="Team key" error="Use 2–5 letters" />);
    expect(html).toContain('<label class="');
    expect(html).toContain('for="key"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="key-message"');
    expect(html).toContain('id="key-message"');
  });
});

describe('Kbd', () => {
  it('gives screen readers the spoken form and hides the symbols', () => {
    const html = renderToStaticMarkup(
      <PlatformProvider platform="mac">
        <Kbd keys="Mod+K" />
      </PlatformProvider>,
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('Command K');
    expect(html).toContain('⌘');
  });
});
