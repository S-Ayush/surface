// Command-menu entries for the attachment operations (SPEC-014 §7, SPEC-005 §4.1; PLAN-014 S5).
// Each opens the app command the Attachments section registers: "Attach file…" the file picker
// (`issue-page:attach-file`), "Link any URL to issue…" the link form (`issue-page:link-url`), and
// the attachment-context entries act on the focused row (`attachment:rename`, `attachment:remove`).
// The section registers them only while the issue can be changed, so a read-only page (archived,
// deleted) offers none of them.
import { Attachment } from '@surface/domain/model';
import type { CommandContext } from '../../command-menu/model.js';
import type { OperationCommand } from '../../command-menu/sources/operations.js';

/** The open issue (anyone who sees it may attach, permissions §3.3). */
function targetIssueRefs({ target }: CommandContext) {
  const id = target.kind === 'issue' ? target.ids[0] : undefined;
  return id === undefined ? {} : { issue: { id } };
}

/**
 * The focused attachment, with what the permission pre-check reads (its creator and team: the
 * creator, team members and Admins may rename or remove it, SPEC-014 §5).
 */
function targetAttachmentRefs({ target, store }: CommandContext) {
  const id = target.kind === 'attachment' ? target.ids[0] : undefined;
  if (id === undefined) return {};
  const row = store?.pool.get(Attachment, id);
  return {
    attachment: row === undefined ? { id } : { id, teamId: row.teamId, creatorId: row.creatorId },
  };
}

export const ATTACHMENT_COMMANDS: Readonly<Record<string, OperationCommand>> = {
  'attachment.createFile': { opens: 'issue-page:attach-file', refs: targetIssueRefs },
  'attachment.createLink': { opens: 'issue-page:link-url', refs: targetIssueRefs },
  'attachment.update': { opens: 'attachment:rename', refs: targetAttachmentRefs },
  'attachment.delete': { opens: 'attachment:remove', refs: targetAttachmentRefs },
};
