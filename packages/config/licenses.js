/**
 * Production dependency licence policy (ADR-0026, PLAN-017 S3).
 * Pure functions only: `scripts/check-licenses.mjs` runs `pnpm licenses` and feeds the result in,
 * so the policy is testable with a fixture.
 */

/** SPDX identifiers a production dependency may use. */
export const ALLOWED_LICENSES = [
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'Unlicense',
  'MIT-0',
  'CC0-1.0',
  'OFL-1.1',
  'PSF-2.0',
];

/**
 * Named exceptions, one by one. Each is a package-name pattern (`*` matches within one name) and
 * the only licence it may carry.
 */
export const LICENSE_EXCEPTIONS = [
  {
    // sharp's prebuilt libvips, linked dynamically (not combined into our code).
    name: '@img/sharp-libvips-*',
    license: 'LGPL-3.0-or-later',
  },
];

/** True when one SPDX expression is allowed: any side of an OR, and every side of an AND. */
export function isAllowedExpression(expression, allowed = ALLOWED_LICENSES) {
  const text = expression.trim();
  if (text === '') return false;
  const orParts = splitTop(text, 'OR');
  if (orParts.length > 1) return orParts.some((part) => isAllowedExpression(part, allowed));
  const andParts = splitTop(text, 'AND');
  if (andParts.length > 1) return andParts.every((part) => isAllowedExpression(part, allowed));
  if (text.startsWith('(') && text.endsWith(')')) {
    return isAllowedExpression(text.slice(1, -1), allowed);
  }
  return allowed.includes(text);
}

/** Splits on a top-level operator, ignoring text inside parentheses. */
function splitTop(text, operator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  const token = ` ${operator} `;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (depth === 0 && text.startsWith(token, i)) {
      parts.push(text.slice(start, i));
      start = i + token.length;
      i = start - 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function matchesName(pattern, name) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`).test(name);
}

/**
 * Reads the JSON from `pnpm licenses list --prod --json` (`{ [licence]: [{ name, versions }] }`)
 * and returns every package whose licence is neither allowed nor a named exception.
 */
export function findViolations(report) {
  const violations = [];
  for (const [license, packages] of Object.entries(report)) {
    if (isAllowedExpression(license)) continue;
    for (const pkg of packages) {
      const excepted = LICENSE_EXCEPTIONS.some(
        (rule) => rule.license === license && matchesName(rule.name, pkg.name),
      );
      if (!excepted) violations.push({ name: pkg.name, versions: pkg.versions ?? [], license });
    }
  }
  return violations;
}
