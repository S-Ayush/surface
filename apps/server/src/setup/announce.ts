/**
 * Startup step 5 (SPEC-004 §8, SPEC-001 §3.1): while setup is incomplete, issue a setup token and
 * log the setup link where the operator looks: `docker compose logs app`.
 */
import type { Logger } from 'pino';
import type { SetupStore } from './store.js';
import { generateSetupToken, setupUrl } from './token.js';

export interface AnnounceOptions {
  readonly publicUrl: string;
  /** `SURFACE_SETUP_TOKEN`, if the operator fixed one; otherwise a fresh token per start. */
  readonly configuredToken: string | undefined;
  readonly log: Logger;
}

/** Returns the setup link it logged, or undefined when setup is complete. */
export async function announceSetup(
  store: Pick<SetupStore, 'isComplete' | 'issueToken'>,
  options: AnnounceOptions,
): Promise<string | undefined> {
  if (await store.isComplete()) return undefined;
  // Only the hash is stored, so a restart can't show the old link again: it issues a new one.
  const token = options.configuredToken ?? generateSetupToken();
  if (!(await store.issueToken(token))) return undefined; // completed meanwhile, elsewhere
  const url = setupUrl(options.publicUrl, token);
  // Warn, so the link shows even with LOG_LEVEL=warn. Logs are JSON lines, so the link is in the
  // message (read at a glance) and in `setupUrl` (for `grep setupUrl`); fields named `token` are
  // redacted, and this link is the one secret the operator must see (SPEC-001 §3.1).
  options.log.warn({ setupUrl: url }, setupMessage(url, options.configuredToken !== undefined));
  return url;
}

export function setupMessage(url: string, configured: boolean): string {
  const lasts = configured
    ? 'It uses SURFACE_SETUP_TOKEN and works until setup is done, unless "surface setup-token" prints another before then.'
    : 'It works until setup is done or the server restarts; "surface setup-token" prints a new one.';
  return `Surface is not set up yet. Open ${url} to create the workspace and the first Admin. ${lasts}`;
}
