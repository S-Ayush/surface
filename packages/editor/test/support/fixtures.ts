// Link and file fixtures shared by the validateDoc tests and the DocView tests, so a stored
// document and a rendered one follow one rule (SPEC-013 §4.4, AC-14).

/** Links the link rule accepts. */
export const GOOD_HREFS: readonly string[] = [
  'https://example.com',
  'HTTP://EXAMPLE.COM/a',
  'HtTpS://x.io/?q=1#f',
  'mailto:ada@example.com',
  'MAILTO:ada@example.com',
];

/** Links it refuses: mixed case, control characters, relative, protocol-relative, not a string. */
export const BAD_HREFS: readonly unknown[] = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'java\tscript:alert(1)',
  'https://exa\u0000mple.com',
  'https://example.com/\u0085',
  ' https://example.com',
  'https://example.com/a b',
  '/relative/path',
  'relative',
  '//evil.example.com',
  'https:evil.example.com',
  'https:\\\\evil.example.com',
  'ftp://example.com',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox',
  '',
  42,
];
