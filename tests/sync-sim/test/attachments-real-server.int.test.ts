/**
 * PLAN-014 S4a, the sync property suite for attachments (not held, plans README §6), against the
 * real server: SPEC-014 AC-6 and AC-17 for the sync engine (links and files attached, renamed and
 * deleted from several clients, and previews set by the system, in any interleaving with the
 * faults, converge: every tab holds exactly the server's attachments, and a fresh bootstrap the
 * same), §6.2 (an upload is claimed once: a second attach of it is refused) and SPEC-014 D28 (a
 * deleted file goes back to its own issue). The lifecycle suite (`lifecycle-real-server`) runs
 * the same steps among deletes, restores, purges and archives.
 *
 * The fake hub runs no operation handlers, so the suite runs on the real server, as the comment
 * and reaction suites do.
 */
import fc from 'fast-check';
import { describe, expect, inject, it } from 'vitest';
import { simParameters } from '../src/context.js';
import { attachmentConvergence, lifecycleConvergence } from '../src/properties.js';
import type { RealServer } from '../src/real-server.js';
import { startRealServer } from '../src/real-server.js';
import type { SimServer } from '../src/server.js';
import { simulate } from '../src/simulate.js';
import type { Case } from '../src/steps.js';
import { attachmentCase, UPLOADS_PER_USER } from '../src/steps.js';

function attachmentServers() {
  let latest: RealServer | undefined;
  const server = async (users: number): Promise<SimServer> => {
    latest = await startRealServer({
      adminUrl: inject('pgAdminUrl'),
      template: inject('pgTemplateDb'),
      users,
    });
    await latest.seedIssueFixtures();
    await latest.seedUploads(UPLOADS_PER_USER);
    return latest;
  };
  return { server, last: () => latest };
}

/**
 * Tab 0 (the Admin) links Alpha; tab 1 (a Member) attaches its first upload to Alpha, then, offline,
 * attaches the same upload to Beta (refused: it is claimed) while tab 0 renames the link. The
 * system sets the file's preview; the Admin deletes the Member's file, and the Member attaches it
 * again to Alpha (D28: back to its own issue, without the old preview). Then Alpha is deleted and
 * restored from the two tabs: both attachments come back with it.
 */
const example: Case = {
  seed: 7,
  users: 2,
  lateUsers: 0,
  webLocks: true,
  steps: [
    { t: 'issueCreate', tab: 0, title: 'Alpha', status: 'default', labels: [] },
    { t: 'issueCreate', tab: 1, title: 'Beta', status: 'default', labels: [] },
    { t: 'wait', ms: 3_000 },
    { t: 'attachmentLink', tab: 0, issue: 0, url: 0 },
    { t: 'attachmentFile', tab: 1, issue: 0, upload: 0 },
    { t: 'wait', ms: 2_000 },
    { t: 'offline', tab: 1, ms: 5_000 },
    { t: 'attachmentFile', tab: 1, issue: 1, upload: 0 },
    { t: 'attachmentRename', tab: 0, attachment: 0, title: 1 },
    { t: 'wait', ms: 8_000 },
    { t: 'attachmentPreview', attachment: 1 },
    { t: 'wait', ms: 2_000 },
    { t: 'attachmentDelete', tab: 0, attachment: 1 },
    { t: 'wait', ms: 2_000 },
    { t: 'attachmentFile', tab: 1, issue: 0, upload: 0 },
    { t: 'wait', ms: 2_000 },
    { t: 'issueDelete', tab: 0, issue: 0 },
    { t: 'wait', ms: 2_000 },
    { t: 'issueRestore', tab: 1, issue: 0 },
    { t: 'wait', ms: 3_000 },
  ],
};

/**
 * SPEC-014 D30, found by the S4a review: tab 0 attaches a file to Alpha and deletes Alpha; then
 * the preview job sets the preview, which the server allows on a deleted issue (§4.4) and logs
 * as an Attachment `U` no replica holds the issue of. Every tab must drop it, as bootstrap does.
 */
const previewAfterDelete: Case = {
  seed: 15,
  users: 3,
  lateUsers: 0,
  webLocks: false,
  steps: [
    { t: 'issueCreate', tab: 0, title: 'Alpha', status: 'default', labels: [] },
    { t: 'wait', ms: 3_000 },
    { t: 'attachmentFile', tab: 0, issue: 0, upload: 0 },
    { t: 'wait', ms: 3_000 },
    { t: 'issueDelete', tab: 0, issue: 0 },
    { t: 'wait', ms: 3_000 },
    { t: 'attachmentPreview', attachment: 0 },
    { t: 'wait', ms: 3_000 },
  ],
};

describe('attachments against the real server', () => {
  it('claims an upload once, re-attaches a deleted file to its issue, and keeps them through a delete and restore (§6.2, D28)', async () => {
    const servers = attachmentServers();
    const result = await simulate(
      example,
      { ...lifecycleConvergence.options, server: servers.server },
      async (outcome) => {
        await lifecycleConvergence.check(outcome);
        const stored = Object.values((await servers.last()?.attachments()) ?? {});
        return {
          outcomes: outcome.world.dispatched
            .filter((d) => d.op.startsWith('attachment.'))
            .map((d) => `${d.op} ${String(d.outcome?.status)}`),
          stored: stored
            .map((a) => [String(a.kind), a.title, a.previewFileId === null])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        };
      },
    );
    expect(result.outcomes).toEqual([
      'attachment.createLink confirmed',
      'attachment.createFile confirmed',
      // The same upload, on Beta: the claim matches nothing (NOT_FOUND).
      'attachment.createFile rejected',
      'attachment.update confirmed',
      'attachment.delete confirmed',
      // Back to Alpha, the file's own issue.
      'attachment.createFile confirmed',
    ]);
    // On Alpha: the re-attached file, without the old preview, and the renamed link.
    expect(result.stored).toEqual([
      ['file', 'screen-1.png', true],
      ['link', 'Spec v2', true],
    ]);
  });

  it('keeps no attachment of a deleted issue when its preview lands afterwards (SPEC-014 D30)', async () => {
    const servers = attachmentServers();
    const stored = await simulate(
      previewAfterDelete,
      { ...lifecycleConvergence.options, server: servers.server },
      async (outcome) => {
        // Every tab holds only the live issues' attachments: none here, as a fresh bootstrap.
        await lifecycleConvergence.check(outcome);
        return Object.values((await servers.last()?.attachments()) ?? {}).map((a) => ({
          kind: a.kind,
          preview: a.previewFileId !== null,
        }));
      },
    );
    // The server keeps it with its deleted issue, now with the preview (§3.7, §4.4).
    expect(stored).toEqual([{ kind: 'file', preview: true }]);
  });

  it('every tab and a fresh bootstrap hold exactly the server’s attachments after any faults (AC-6, AC-17)', async () => {
    const servers = attachmentServers();
    // What the runs did, so a generator that stops reaching the server fails here, not silently.
    const confirmed = new Map<string, number>();
    let previews = 0;
    await fc.assert(
      fc.asyncProperty(attachmentCase(), (simCase) =>
        simulate(
          simCase,
          { ...attachmentConvergence.options, server: servers.server },
          async (outcome) => {
            await attachmentConvergence.check(outcome);
            for (const d of outcome.world.dispatched) {
              if (d.outcome?.status === 'confirmed') {
                confirmed.set(d.op, (confirmed.get(d.op) ?? 0) + 1);
              }
            }
            const stored = Object.values((await servers.last()?.attachments()) ?? {});
            previews += stored.filter((a) => a.previewFileId !== null).length;
          },
        ),
      ),
      simParameters(),
    );
    for (const op of [
      'attachment.createLink',
      'attachment.createFile',
      'attachment.update',
      'attachment.delete',
    ]) {
      expect(confirmed.get(op) ?? 0, op).toBeGreaterThan(0);
    }
    expect(previews, 'attachments with a preview').toBeGreaterThan(0);
  });
});
