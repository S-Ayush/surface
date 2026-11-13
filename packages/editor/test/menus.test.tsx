// @vitest-environment jsdom
// PLAN-013 S2: the slash menu's match and entries, and the link field's address rule (SPEC-013 §3.5).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toHref } from '../src/bubbleMenu.js';
import { searchEmoji, matchEmojiTrigger } from '../src/emoji/autocomplete.js';
import { applySlash, matchSlashTrigger, slashItems } from '../src/slash.js';
import { destroyAll, docOf, makeEditor, paragraph, type } from './support/web-editor.js';

afterEach(destroyAll);

describe('slash menu', () => {
  it('lists the blocks plus Image and File, and filters by what is typed', () => {
    const labels = slashItems('').map((item) => item.label);
    expect(labels).toEqual(
      expect.arrayContaining(['Text', 'Heading 1', 'Heading 4', 'Checklist', 'Image', 'File']),
    );
    expect(slashItems('head').map((item) => item.label)).toEqual([
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Heading 4',
    ]);
    expect(slashItems('zzz')).toEqual([]);
  });

  it('matches `/` only alone on an empty line', () => {
    const empty = makeEditor({ mode: 'description' });
    empty.editor.commands.focus();
    type(empty.editor, '/he');
    expect(matchSlashTrigger(empty.editor.state)).toMatchObject({ query: 'he', from: 1, to: 4 });

    const mid = makeEditor({ content: docOf(paragraph('a')) });
    mid.editor.commands.focus('end');
    type(mid.editor, ' /he');
    expect(matchSlashTrigger(mid.editor.state)).toBeNull();
  });

  it('removes the `/query` and turns the line into the chosen block', () => {
    const harness = makeEditor({ mode: 'description' });
    harness.editor.commands.focus();
    type(harness.editor, '/head');
    const match = matchSlashTrigger(harness.editor.state);
    const item = slashItems('head')[1];
    if (match === null || item === undefined) throw new Error('expected a match and an item');
    applySlash(harness.editor, match, item, vi.fn());
    expect(harness.json().content).toEqual([{ type: 'heading', attrs: { level: 2 } }]);
  });

  it('hands Image and File to the file chooser', () => {
    const harness = makeEditor({ mode: 'description' });
    harness.editor.commands.focus();
    type(harness.editor, '/ima');
    const match = matchSlashTrigger(harness.editor.state);
    const item = slashItems('ima')[0];
    if (match === null || item === undefined) throw new Error('expected a match and an item');
    const choose = vi.fn();
    applySlash(harness.editor, match, item, choose);
    expect(choose).toHaveBeenCalledWith('image');
  });
});

describe('emoji trigger', () => {
  it('needs a colon and two letters, after a space or at the line start', () => {
    const cases: [string, string | null][] = [
      [':', null],
      [':t', null],
      [':th', 'th'],
      ['hi :thu', 'thu'],
      ['http://x', null],
      ['a:th', null],
    ];
    for (const [input, query] of cases) {
      const harness = makeEditor();
      harness.editor.commands.focus();
      type(harness.editor, input);
      expect(matchEmojiTrigger(harness.editor.state)?.query ?? null).toBe(query);
      harness.destroy();
    }
  });

  it('finds nothing in an empty data set', () => {
    expect(searchEmoji([], 'th')).toEqual([]);
  });
});

describe('link field address', () => {
  it.each([
    ['https://example.com/a', 'https://example.com/a'],
    ['example.com', 'https://example.com'],
    ['example.com/docs?q=1', 'https://example.com/docs?q=1'],
    ['  mailto:ada@example.com ', 'mailto:ada@example.com'],
    ['javascript:alert(1)', 'javascript:alert(1)'],
    ['not a link', 'not a link'],
  ])('reads %j as %j (the link rule then accepts or refuses it)', (input, href) => {
    expect(toHref(input)).toBe(href);
  });
});
