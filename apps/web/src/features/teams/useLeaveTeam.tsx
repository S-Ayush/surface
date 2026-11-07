// Leaving a team, wherever it is offered (Settings → Teams, the team ⋯ menu, Members). Leaving a
// private team is asked first: only a member can add you back. A public team is one click to join
// again, so it isn't. The leave shows when the server confirms it (no prediction yet, PLAN-001 S8).
import { teamLeave } from '@surface/operations';
import { Button, Dialog, DialogClose } from '@surface/ui';
import { useState, type ReactNode } from 'react';
import { useApp } from '../../app/context.js';
import { submitMutation, toastIfFailed } from './submit.js';

export type LeavableTeam = {
  readonly key: string;
  readonly name: string;
  readonly private: boolean;
};

export function useLeaveTeam(team: LeavableTeam): {
  /** Leaves at once (public team) or asks first (private team). */
  readonly leave: () => void;
  readonly busy: boolean;
  /** Render it once, next to the control that calls `leave`. */
  readonly dialog: ReactNode;
} {
  const app = useApp();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const store = app.store;
    if (store === null || busy) return;
    setBusy(true);
    // A server refusal is the shell's toast (SPEC-002 §3.5); a change the store didn't take isn't.
    toastIfFailed(await submitMutation(store, teamLeave, { team: team.key }));
    setBusy(false);
    setAsking(false);
  };

  const dialog = team.private ? (
    <Dialog
      open={asking}
      onOpenChange={setAsking}
      title={`Leave ${team.name}?`}
      description={`${team.key} is private: you won't see it anymore, and only a member can add you back.`}
      size="sm"
      footer={
        <>
          <DialogClose>
            <Button variant="ghost" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="danger" loading={busy} onClick={() => void run()}>
            Leave team
          </Button>
        </>
      }
    />
  ) : null;

  return {
    leave: () => {
      if (team.private) setAsking(true);
      else void run();
    },
    busy,
    dialog,
  };
}
