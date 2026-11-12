// SPEC-012 AC-7 (picker behaviour), E17, E21. The key rules are pure (`model.ts`); the DOM side
// (focus, axe, real key presses) is in the story tests (`pnpm test:storybook`).
import fc from 'fast-check';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  closeEffects,
  filterOptions,
  initialState,
  onKey,
  setQuery,
  showsQuickKeys,
  toggle,
  type PickerEffect,
  type PickerOption,
  type PickerState,
} from '../src/components/PropertyPicker/model.js';
import { PropertyPicker } from '../src/components/PropertyPicker/PropertyPicker.js';
import { PlatformProvider } from '../src/platform.js';

const priorities: PickerOption[] = [
  { id: 'p0', label: 'No priority', quickKey: '0' },
  { id: 'p1', label: 'Urgent', quickKey: '1' },
  { id: 'p2', label: 'High', quickKey: '2' },
  { id: 'p3', label: 'Medium', quickKey: '3' },
  { id: 'p4', label: 'Low', quickKey: '4' },
];

const labels: PickerOption[] = [
  { id: 'bug', label: 'Bug', group: 'Type', exclusiveGroup: 'type' },
  { id: 'feature', label: 'Feature', group: 'Type', exclusiveGroup: 'type' },
  { id: 'design', label: 'Needs design' },
  { id: 'web', label: 'Web' },
];

/** Runs key presses (or typed text) against the model and collects every effect. */
function press(
  start: PickerState,
  options: readonly PickerOption[],
  mode: 'single' | 'multi',
  ...keys: string[]
) {
  let state = start;
  const effects: PickerEffect[] = [];
  for (const key of keys) {
    const result = onKey(state, key, options, mode);
    state = result.state;
    effects.push(...result.effects);
    if (!result.handled && key.length === 1) {
      state = setQuery(state, state.query + key, options);
    }
  }
  return { state, effects };
}

describe('quick keys (single mode)', () => {
  it('pick by digit while the query is empty, then close', () => {
    const { effects } = press(initialState(priorities, [], 'p0'), priorities, 'single', '2');
    expect(effects).toEqual([{ type: 'select', id: 'p2' }, { type: 'close' }]);
  });

  it('are typed into the query once it has text, so "v2" finds nothing and picks nothing (E17)', () => {
    const { state, effects } = press(
      initialState(priorities, [], null),
      priorities,
      'single',
      'v',
      '2',
    );
    expect(state.query).toBe('v2');
    expect(effects).toEqual([]);
  });

  it('do nothing for a key no option claims, and the key is typed', () => {
    const { state, effects } = press(initialState(priorities, [], null), priorities, 'single', '9');
    expect(effects).toEqual([]);
    expect(state.query).toBe('9');
  });

  it('are shown only while they work', () => {
    const empty = initialState(priorities, [], null);
    expect(showsQuickKeys(empty, 'single')).toBe(true);
    expect(showsQuickKeys(setQuery(empty, 'u', priorities), 'single')).toBe(false);
    expect(showsQuickKeys(initialState(labels, [], undefined), 'multi')).toBe(false);
  });

  it('never fire for a disabled option', () => {
    const options = priorities.map((o) => (o.id === 'p3' ? { ...o, disabled: true } : o));
    const { effects } = press(initialState(options, [], null), options, 'single', '3');
    expect(effects).toEqual([]);
  });

  it('property: a digit never picks once any letter was typed first', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,4}$/),
        fc.constantFrom('0', '1', '2', '3', '4'),
        (letters, digit) => {
          const keys = [...letters, digit];
          const { effects } = press(
            initialState(priorities, [], null),
            priorities,
            'single',
            ...keys,
          );
          expect(effects.filter((e) => e.type === 'select')).toEqual([]);
        },
      ),
    );
  });
});

describe('highlight and Enter (single mode)', () => {
  it('starts on the current value and moves with the arrows, stopping at the ends', () => {
    const start = initialState(priorities, [], 'p2');
    expect(start.highlightId).toBe('p2');
    expect(press(start, priorities, 'single', 'ArrowDown').state.highlightId).toBe('p3');
    expect(
      press(start, priorities, 'single', 'ArrowUp', 'ArrowUp', 'ArrowUp').state.highlightId,
    ).toBe('p0');
    expect(
      press(start, priorities, 'single', ...Array.from({ length: 9 }, () => 'ArrowDown')).state
        .highlightId,
    ).toBe('p4');
  });

  it('picks the highlighted option and closes on Enter', () => {
    const { effects } = press(
      initialState(priorities, [], 'p0'),
      priorities,
      'single',
      'ArrowDown',
      'Enter',
    );
    expect(effects).toEqual([{ type: 'select', id: 'p1' }, { type: 'close' }]);
  });

  it('skips disabled options and moves the highlight to the first match while typing', () => {
    const options = priorities.map((o) => (o.id === 'p1' ? { ...o, disabled: true } : o));
    const start = initialState(options, [], 'p0');
    expect(press(start, options, 'single', 'ArrowDown').state.highlightId).toBe('p2');
    const typed = press(start, options, 'single', 'l', 'o');
    expect(typed.state.highlightId).toBe('p4');
  });

  it('does nothing on Enter when no option matches', () => {
    const { effects } = press(
      initialState(priorities, [], null),
      priorities,
      'single',
      'z',
      'Enter',
    );
    expect(effects).toEqual([]);
  });

  it('closes without picking on Esc', () => {
    const { effects } = press(initialState(priorities, [], 'p1'), priorities, 'single', 'Escape');
    expect(effects).toEqual([{ type: 'close' }]);
  });
});

describe('labels picker (multi mode)', () => {
  const start = initialState(labels, ['web'], undefined);

  it('Space toggles the highlighted label and keeps the picker open', () => {
    const { state, effects } = press(start, labels, 'multi', ' ');
    expect(state.selected).toEqual(['web', 'bug']);
    expect(effects).toEqual([]);
  });

  it('Space is typed into the query once it has text ("Needs design")', () => {
    const { state, effects } = press(start, labels, 'multi', 'N', 'e', 'e', 'd', 's', ' ', 'd');
    expect(state.query).toBe('Needs d');
    expect(state.selected).toEqual(['web']);
    expect(effects).toEqual([]);
    expect(filterOptions(labels, state.query).map((o) => o.id)).toEqual(['design']);
  });

  it('Space then Enter applies the toggle once and never toggles it back (E21)', () => {
    const { state, effects } = press(start, labels, 'multi', ' ', 'Enter');
    expect(state.selected).toEqual(['web', 'bug']);
    expect(effects).toEqual([{ type: 'apply', ids: ['web', 'bug'] }, { type: 'close' }]);
  });

  it('Enter with nothing toggled toggles the highlighted label first, then applies', () => {
    const { effects } = press(start, labels, 'multi', 'ArrowDown', 'ArrowDown', 'Enter');
    expect(effects).toEqual([{ type: 'apply', ids: ['web', 'design'] }, { type: 'close' }]);
  });

  it('Enter with nothing toggled and nothing highlighted closes without applying', () => {
    const typed = press(start, labels, 'multi', 'z', 'z', 'z');
    expect(typed.state.highlightId).toBeNull();
    const { effects } = press(typed.state, labels, 'multi', 'Enter');
    expect(effects).toEqual([{ type: 'close' }]);
  });

  it('Esc applies every toggle in one apply (there is no cancel)', () => {
    const { effects } = press(start, labels, 'multi', ' ', 'ArrowDown', 'ArrowDown', ' ', 'Escape');
    expect(effects).toEqual([{ type: 'apply', ids: ['web', 'bug', 'design'] }, { type: 'close' }]);
  });

  it('closing with no net change applies nothing', () => {
    const toggled = toggle(toggle(start, labels, 'design'), labels, 'design');
    expect(toggled.touched).toBe(true);
    expect(closeEffects(toggled)).toEqual([{ type: 'close' }]);
    expect(press(start, labels, 'multi', 'Escape').effects).toEqual([{ type: 'close' }]);
  });

  it('keeps one label per exclusive group: choosing one unchecks the other (INV-07)', () => {
    const withBug = initialState(labels, ['bug', 'web'], undefined);
    const next = toggle(withBug, labels, 'feature');
    expect([...next.selected].sort()).toEqual(['feature', 'web']);
    expect(toggle(next, labels, 'feature').selected).toEqual(['web']);
  });

  it('labels outside a group never uncheck each other', () => {
    const next = toggle(
      toggle(initialState(labels, [], undefined), labels, 'design'),
      labels,
      'web',
    );
    expect([...next.selected].sort()).toEqual(['design', 'web']);
  });

  it('property: any sequence of Space and arrows keeps at most one label of an exclusive group', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(' ', 'ArrowDown', 'ArrowUp'), { maxLength: 40 }),
        (keys) => {
          const { state } = press(initialState(labels, [], undefined), labels, 'multi', ...keys);
          const types = state.selected.filter((id) => id === 'bug' || id === 'feature');
          expect(types.length).toBeLessThanOrEqual(1);
          expect(new Set(state.selected).size).toBe(state.selected.length);
        },
      ),
    );
  });

  it('property: Enter after any toggles applies the checked set once, and never undoes the last Space', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(' ', 'ArrowDown', 'ArrowUp'), { minLength: 1, maxLength: 30 }),
        (keys) => {
          const before = press(initialState(labels, [], undefined), labels, 'multi', ...keys);
          const after = press(before.state, labels, 'multi', 'Enter');
          const applies = after.effects.filter((e) => e.type === 'apply');
          const toggledAny = keys.includes(' ');
          if (toggledAny) {
            // Enter applied exactly what Space left checked (or nothing, when that is unchanged).
            expect(after.state.selected).toEqual(before.state.selected);
          }
          expect(applies.length).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});

describe('filtering', () => {
  it('matches every word of the query against the label and keywords, ignoring case', () => {
    const people: PickerOption[] = [
      { id: 'a', label: 'Ada Lovelace', keywords: 'ada@example.com ada' },
      { id: 'b', label: 'Grace Hopper', keywords: 'grace@example.com' },
    ];
    expect(filterOptions(people, 'LOVE').map((o) => o.id)).toEqual(['a']);
    expect(filterOptions(people, 'grace example').map((o) => o.id)).toEqual(['b']);
    expect(filterOptions(people, 'ada hopper')).toEqual([]);
    expect(filterOptions(people, '   ')).toHaveLength(2);
  });
});

describe('PropertyPicker markup', () => {
  const render = (node: React.ReactElement) =>
    renderToStaticMarkup(<PlatformProvider platform="mac">{node}</PlatformProvider>);

  it('is a combobox over a listbox of options with the current value selected', () => {
    const html = render(
      <PropertyPicker
        mode="single"
        label="Change priority"
        options={priorities}
        value="p2"
        onSelect={() => {}}
      />,
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="Change priority"');
    expect(html).toContain('role="listbox"');
    expect(html.match(/role="option"/g)).toHaveLength(5);
    expect(html).toMatch(/aria-selected="true"[^>]*>(?:(?!role="option").)*High/);
    // The highlight starts on the current value.
    expect(html).toMatch(/aria-activedescendant="[^"]*-p2"/);
  });

  it('shows quick-key hints on an empty query, and not in the labels picker', () => {
    const single = render(
      <PropertyPicker
        mode="single"
        label="Priority"
        options={priorities}
        value={null}
        onSelect={() => {}}
      />,
    );
    expect(single.match(/<kbd/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    const multi = render(
      <PropertyPicker
        mode="multi"
        label="Labels"
        options={labels}
        values={[]}
        onApply={() => {}}
      />,
    );
    expect(multi).not.toContain('<kbd');
    expect(multi).toContain('aria-multiselectable="true"');
  });

  it('groups options under a named heading', () => {
    const html = render(
      <PropertyPicker
        mode="multi"
        label="Labels"
        options={labels}
        values={['bug']}
        onApply={() => {}}
      />,
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('>Type<');
    expect(html.match(/role="group"/g)).toHaveLength(1);
  });
});
