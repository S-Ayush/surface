export const ALLOWED_LICENSES: string[];
export const LICENSE_EXCEPTIONS: { name: string; license: string }[];
export function isAllowedExpression(expression: string, allowed?: string[]): boolean;
export function findViolations(
  report: Record<string, { name: string; versions?: string[] }[]>,
): { name: string; versions: string[]; license: string }[];
