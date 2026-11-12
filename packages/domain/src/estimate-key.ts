/** One value a team's estimate scale offers (SPEC-010 §4.3). */
export interface EstimateOption {
  readonly value: number;
  readonly label: string;
}

/**
 * What a digit typed in the estimate picker's empty search field does (SPEC-012 §3.5): `0` clears
 * the estimate (`null`); a digit equal to a scale value picks that value (fibonacci 5 is 5,
 * t-shirt 5 is L); any other digit does nothing (`undefined`). `options` are the scale's values,
 * without the "No estimate" row.
 */
export function estimateForDigit(
  options: readonly EstimateOption[],
  digit: number,
): number | null | undefined {
  if (!Number.isInteger(digit) || digit < 0 || digit > 9) return undefined;
  if (digit === 0) return null;
  return options.find((option) => option.value === digit)?.value;
}
