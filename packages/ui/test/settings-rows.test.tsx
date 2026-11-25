// SettingsGroup and SettingsRow server-rendered structure (PLAN-016 S7): headings, list names,
// label and hint association. Visuals and axe are in the stories (`pnpm test:storybook`).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsGroup, SettingsPanel } from '../src/components/SettingsGroup/SettingsGroup.js';
import { SettingsRow, settingsHintId } from '../src/components/SettingsRow/SettingsRow.js';

/** The value of `attr` on the first tag that has it. */
function attr(html: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(html)?.[1];
}

describe('SettingsGroup', () => {
  it('has a level-two heading and is not a second landmark with the same name', () => {
    const html = renderToStaticMarkup(
      <SettingsGroup title="Account">
        <SettingsPanel>form</SettingsPanel>
      </SettingsGroup>,
    );
    expect(html).toMatch(/<h2[^>]*>Account<\/h2>/);
    expect(html).not.toContain('aria-labelledby');
  });

  it('renders rows as a named list of items', () => {
    const html = renderToStaticMarkup(
      <SettingsGroup title="Members" list listLabel="Members">
        <SettingsRow as="li" label="Ada" />
        <SettingsRow as="li" label="Grace" />
      </SettingsGroup>,
    );
    expect(html).toMatch(/<ul class="[^"]*" aria-label="Members"/);
    expect(html.match(/<li[ >]/g)).toHaveLength(2);
    expect(html).not.toContain('role="group"');
  });

  it('puts a description between the heading and the card', () => {
    const html = renderToStaticMarkup(
      <SettingsGroup title="Sessions" description={<p>Browsers signed in.</p>} />,
    );
    expect(html.indexOf('Sessions')).toBeLessThan(html.indexOf('Browsers signed in.'));
  });

  it('shows actions beside the heading', () => {
    const html = renderToStaticMarkup(
      <SettingsGroup title="Labels" actions={<button type="button">New</button>} />,
    );
    expect(html).toContain('<button type="button">New</button>');
  });
});

describe('SettingsRow', () => {
  it('labels its control with <label for> when given a control id', () => {
    const html = renderToStaticMarkup(
      <SettingsRow label="Display name" controlId="dn">
        <input id="dn" />
      </SettingsRow>,
    );
    expect(html).toMatch(/<label for="dn"[^>]*>Display name<\/label>/);
    expect(html).not.toContain('role="group"');
  });

  it('is a group named by its label and described by its hint otherwise', () => {
    const html = renderToStaticMarkup(
      <SettingsRow label="Theme" hint="System follows your computer." />,
    );
    const labelledby = attr(html, 'aria-labelledby');
    const describedby = attr(html, 'aria-describedby');
    expect(html).toContain('role="group"');
    expect(html).toContain(`id="${labelledby}"`);
    expect(html).toMatch(new RegExp(`id="${describedby}"[^>]*>System follows your computer\\.`));
  });

  it('gives a control row a hint id for the control to be described by', () => {
    const html = renderToStaticMarkup(
      <SettingsRow label="Archive after" hint="Changes apply within a day." controlId="archive" />,
    );
    expect(html).toContain('id="' + settingsHintId('archive') + '"');
    expect(settingsHintId('archive')).toBe('archive-hint');
  });

  it('keeps an anchor id', () => {
    expect(renderToStaticMarkup(<SettingsRow id="row-theme" label="Theme" />)).toContain(
      'id="row-theme"',
    );
  });
});
