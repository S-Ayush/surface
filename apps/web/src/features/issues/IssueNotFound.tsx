// The issue page's not-found state (SPEC-012 §3.4 item 7, AC-15). One component for an issue that
// doesn't exist and one the user can't see: it takes the same props for both and names nothing
// the user didn't type. `teamKey` is set only when the replica holds that team, which a private
// team the user isn't in never is, so its key gets the same "Go home" as an unknown one.
import { issueIdentifier, parseIssueRef } from '@surface/domain';
import { Button, EmptyState } from '@surface/ui';
import { useNavigate } from '@tanstack/react-router';
import { MapPinOff } from 'lucide-react';
import { PageHeader } from '../../shell/PageHeader.js';
import styles from '../../pages/Pages.module.css';

/** What the user typed, as the page names it: `ENG-99`, or "This issue" for an id. */
export function notFoundSubject(ref: string): string {
  const parsed = parseIssueRef(ref);
  return parsed?.by === 'identifier' ? issueIdentifier(parsed.key, parsed.number) : 'This issue';
}

export function IssueNotFound({
  issueRef,
  teamKey,
}: {
  issueRef: string;
  /** The key of a team the replica holds, for "Go to ENG issues". */
  teamKey?: string | undefined;
}) {
  const navigate = useNavigate();
  const title = `${notFoundSubject(issueRef)} doesn't exist, or you don't have access to it.`;
  return (
    <>
      <PageHeader crumbs={['Issue not found']} title="Issue not found" />
      <div className={styles.centered}>
        <EmptyState
          icon={<MapPinOff />}
          title={title}
          action={
            <Button
              variant="primary"
              onClick={() => {
                void navigate({ to: teamKey === undefined ? '/' : `/team/${teamKey}` });
              }}
            >
              {teamKey === undefined ? 'Go home' : `Go to ${teamKey} issues`}
            </Button>
          }
        />
      </div>
    </>
  );
}
