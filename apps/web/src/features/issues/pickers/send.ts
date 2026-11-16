// Sending one `issue.update` from a picker or a command (SPEC-012 §3.5): optimistic, and a
// refusal is the shell's toast (SPEC-002 §3.5), so this only reports a change the store didn't take.
import { issueUpdate } from '@surface/operations';
import { submitMutation, toastIfFailed, type MutationStore } from '../../teams/submit.js';
import type { IssueUpdateInput } from '../issue-pickers.js';

export function sendIssueUpdate(
  store: MutationStore,
  input: IssueUpdateInput | undefined,
): Promise<void> {
  if (input === undefined) return Promise.resolve();
  return submitMutation(store, issueUpdate, input).then(toastIfFailed);
}
