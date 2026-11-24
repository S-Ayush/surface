// The issue page's not-found state (SPEC-012 §3.4 item 7, AC-15). One component, no data but what
// the user typed: an issue that doesn't exist, one in an unknown team and one in a private team
// the user can't see all give the same markup. So it always offers "Go home": a "Go to ENG issues"
// button would tell the user which team keys exist.
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

/** E5 of SPEC-015: the page showed this deleted issue, then it was purged. */
export const PURGED_TITLE = 'This issue was deleted permanently.';

/**
 * `purged`: this page showed the issue as deleted before the server stopped knowing it (SPEC-015
 * E5). Only then: opened afresh after a purge, the page reads like any unknown identifier (E9).
 */
export function IssueNotFound({
  issueRef,
  purged = false,
}: {
  issueRef: string;
  purged?: boolean;
}) {
  const navigate = useNavigate();
  const title = purged
    ? PURGED_TITLE
    : `${notFoundSubject(issueRef)} doesn't exist, or you don't have access to it.`;
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
                void navigate({ to: '/' });
              }}
            >
              Go home
            </Button>
          }
        />
      </div>
    </>
  );
}
