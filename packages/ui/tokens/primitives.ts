// Primitive layer (design-system §2). Raw colour values live only in token files: Stylelint rejects
// hex and rgb() everywhere else (AC-11). Components never read primitives; they use semantic tokens.

/** A colour in `#RRGGBB` form. */
export type Hex = `#${string}`;

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** The 12-hue palette for labels, teams and projects (design-system §2.2). No free hex input in v1. */
export const LABEL_HUES = [
  'gray',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'teal',
  'cyan',
  'blue',
  'violet',
  'pink',
] as const;
export type LabelHue = (typeof LABEL_HUES)[number];

type Scale = Readonly<Record<number, Hex>>;

/**
 * Colour scales per theme. Step numbers follow the usual 1–12 convention (1–2 app backgrounds,
 * 3–6 component backgrounds, 7–8 borders, 9–10 solids, 11–12 text); scales only define the steps in
 * use. Every primitive must exist in both themes (checked by the generator).
 */
export const scales: Readonly<Record<Theme, Readonly<Record<string, Scale>>>> = {
  light: {
    gray: {
      1: '#FFFFFF',
      2: '#FAFBFC',
      3: '#F4F5F7',
      4: '#F0F1F4',
      5: '#ECEDF1',
      6: '#E8EAEE',
      7: '#DFE2E7',
      8: '#C7CCD4',
      9: '#858B98',
      10: '#5F6676',
      11: '#4A5060',
      12: '#16181D',
    },
    teal: { 1: '#F3FAFA', 3: '#E2F3F2', 8: '#16908C', 9: '#0A7A77', 10: '#086A67' },
    red: { 3: '#FDECEC', 9: '#CC3636', 10: '#B32E2E' },
    amber: { 3: '#FDF3E3', 9: '#B86E0C' },
    green: { 3: '#E8F6EE', 9: '#2B9255' },
    blue: { 3: '#EAF0FC', 9: '#3569D4' },
    // Layered surfaces (PLAN-016 S1, design-system §2.1): 1 app, 2 panel, 3 elevated, 4 hover,
    // 5 active, 6 group header band, 7 decorative hairline border.
    surface: {
      1: '#F3F4F6',
      2: '#FCFCFD',
      3: '#FFFFFF',
      4: '#EFF1F3',
      5: '#E6E9ED',
      6: '#F7F8F9',
      7: '#DCDFE4',
    },
  },
  dark: {
    gray: {
      1: '#0E1013',
      2: '#111316',
      3: '#14171B',
      4: '#1B1F24',
      5: '#1F2329',
      6: '#252B32',
      7: '#2A2F36',
      8: '#3B414A',
      9: '#68707C',
      10: '#8C94A1',
      11: '#B2B8C3',
      12: '#ECEEF1',
    },
    teal: { 1: '#04201F', 3: '#123130', 8: '#3ACBC6', 9: '#2EC4BF', 10: '#4ED2CD' },
    red: { 3: '#2C1517', 9: '#F06868', 10: '#F48A8A' },
    amber: { 3: '#2A1F0E', 9: '#EBA33F' },
    green: { 3: '#11271A', 9: '#4FC47D' },
    blue: { 3: '#141E33', 9: '#6E9EF6' },
    surface: {
      1: '#0B0D0F',
      2: '#121518',
      3: '#1A1E22',
      4: '#1A1E23',
      5: '#22272D',
      6: '#16191D',
      7: '#262B31',
    },
  },
};

/**
 * Label hues, tuned per theme to reach 3:1 as icon or dot colours on every surface they sit on
 * (design-system §2.2, checked by the contrast test).
 */
export const hues: Readonly<Record<Theme, Readonly<Record<LabelHue, Hex>>>> = {
  light: {
    gray: '#7C8492',
    red: '#DF5656',
    orange: '#D36317',
    amber: '#B3770F',
    yellow: '#99820C',
    lime: '#668F1E',
    green: '#2C964F',
    teal: '#1A938B',
    cyan: '#198EAC',
    blue: '#4F81E6',
    violet: '#966CE0',
    pink: '#DA509A',
  },
  dark: {
    gray: '#8E95A1',
    red: '#E47272',
    orange: '#E7752A',
    amber: '#CB8710',
    yellow: '#AF940E',
    lime: '#75A423',
    green: '#31AA5A',
    teal: '#1DA79E',
    cyan: '#1CA3C4',
    blue: '#6A94EA',
    violet: '#A783E5',
    pink: '#E06EAB',
  },
};

/** Flattens the primitives of one theme into CSS custom-property names (`gray-1`, `hue-red`). */
export function primitivesFor(theme: Theme): ReadonlyMap<string, Hex> {
  const out = new Map<string, Hex>();
  for (const [scale, steps] of Object.entries(scales[theme])) {
    for (const [step, value] of Object.entries(steps)) out.set(`${scale}-${step}`, value);
  }
  for (const hue of LABEL_HUES) out.set(`hue-${hue}`, hues[theme][hue]);
  return out;
}
