// What the estimates page and its command entries show for each scale (SPEC-010 §3.3, §4.3, D12).
// The value lists come from the domain's `estimateValues`, so the page can't drift from what a
// write accepts.
import { estimateValues, formatEstimate, type EstimateScale } from '@surface/domain';

export type ScaleOption = {
  readonly scale: EstimateScale;
  /** "Exponential" */
  readonly title: string;
  /** "1, 2, 4, 8, 16 Points" */
  readonly values: string;
  /** "Exponential (1, 2, 4, 8, 16 Points)" */
  readonly label: string;
};

/** The select's order: Linear's own (D12). */
const ORDER: readonly { scale: EstimateScale; title: string }[] = [
  { scale: 'off', title: 'Not in use' },
  { scale: 'exponential', title: 'Exponential' },
  { scale: 'fibonacci', title: 'Fibonacci' },
  { scale: 'linear', title: 'Linear' },
  { scale: 'tshirt', title: 'T-Shirt' },
];

function valuesOf(scale: EstimateScale): string {
  const config = { scale, extended: false, allowZero: false };
  const shown = estimateValues(config).map((value) => formatEstimate(config, value));
  if (shown.length === 0) return '';
  // T-shirt sizes aren't points.
  return scale === 'tshirt' ? shown.join(', ') : `${shown.join(', ')} Points`;
}

export const SCALE_OPTIONS: readonly ScaleOption[] = ORDER.map(({ scale, title }) => {
  const values = valuesOf(scale);
  return { scale, title, values, label: values === '' ? title : `${title} (${values})` };
});

/** Where a team's estimate settings are. Its key comes from the replica, not the label. */
export function estimatesPath(teamKey: string): string {
  return `/settings/teams/${encodeURIComponent(teamKey)}/estimates`;
}
