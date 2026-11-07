// The teams feature's shell host (features/hosts.ts): answers "Create team…" (`form:create-team`)
// from the command menu and the sidebar "+" with the create-team dialog (SPEC-001 §3.7).
import { useCallback } from 'react';
import type { AppModel } from '../../app/AppModel.js';
import { useApp } from '../../app/context.js';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import { useCreateTeamDialog } from './CreateTeamDialog.js';

/**
 * Whether Create team applies: hosts mount before the replica is ready, and the form needs it for
 * the taken keys and the creator's time zone.
 */
export const canCreateTeam = (app: Pick<AppModel, 'store' | 'session'>): boolean =>
  app.store?.status === 'ready' && app.session !== null;

export function TeamsHost() {
  const app = useApp();
  const create = useCreateTeamDialog();
  const when = useCallback(() => canCreateTeam(app), [app]);
  useCommand('form:create-team', create.open, { when });
  return create.dialog;
}
