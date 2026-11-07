/**
 * How long each emailed or copied link works, in words (state-machines.md "Tokens"; SPEC-001
 * §3.2–3.4). The server's emails and the web's pages both say it; the server's lifetimes in
 * milliseconds (`mail/link-tokens.ts`) are tested to match.
 */
export const LINK_LIFETIME_TEXT = {
  magicLink: '15 minutes',
  passwordReset: '1 hour',
  invite: '7 days',
} as const;
