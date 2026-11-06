import { Check } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { cx } from '../../internal/cx.js';
import { LABEL_HUES, type LabelHue } from '../../tokens.gen.js';
import styles from './ColorPicker.module.css';

/** Sentence-case names for the 12 palette hues, used as accessible names. */
export const HUE_NAMES: Readonly<Record<LabelHue, string>> = {
  gray: 'Gray',
  red: 'Red',
  orange: 'Orange',
  amber: 'Amber',
  yellow: 'Yellow',
  lime: 'Lime',
  green: 'Green',
  teal: 'Teal',
  cyan: 'Cyan',
  blue: 'Blue',
  violet: 'Violet',
  pink: 'Pink',
};

function isLabelHue(value: string): value is LabelHue {
  return LABEL_HUES.some((hue) => hue === value);
}

export type ColorPickerProps = {
  value: LabelHue | undefined;
  onValueChange: (hue: LabelHue) => void;
  /** Names the group, e.g. "Team color". */
  'aria-label': string;
  className?: string;
};

/** The 12-hue palette grid for labels, teams and projects (design-system §2.2, §5.3). No free hex. */
export function ColorPicker({
  value,
  onValueChange,
  className,
  'aria-label': ariaLabel,
}: ColorPickerProps) {
  return (
    <RadioGroup.Root
      className={cx(styles.root, className)}
      value={value ?? ''}
      onValueChange={(next) => {
        if (isLabelHue(next)) onValueChange(next);
      }}
      loop
      aria-label={ariaLabel}
    >
      {LABEL_HUES.map((hue) => (
        <RadioGroup.Item
          key={hue}
          value={hue}
          className={styles.swatch}
          style={{ backgroundColor: `var(--label-${hue})` }}
          aria-label={HUE_NAMES[hue]}
        >
          <RadioGroup.Indicator className={styles.indicator}>
            <Check aria-hidden />
          </RadioGroup.Indicator>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
