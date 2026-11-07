// What the shell shows in place of the page while the store opens (SPEC-005 §3, SPEC-002 §7).
import type { SyncStatus } from '@surface/sync-client';

export type GateView = 'page' | 'loading' | 'failed' | 'outdated';

/**
 * The progress, failure and outdated screens are for the first load only. Once the replica has
 * been ready the page stays: a resync must not unmount it (and lose its state), and an outdated
 * store raises the persistent banner instead (SPEC-005 §8).
 */
export function gateView(status: SyncStatus, readyOnce: boolean): GateView {
  if (readyOnce || status === 'ready') return 'page';
  if (status === 'failed') return 'failed';
  if (status === 'outdated') return 'outdated';
  return 'loading';
}
