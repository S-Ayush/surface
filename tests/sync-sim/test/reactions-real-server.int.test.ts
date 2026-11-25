/**
 * PLAN-013 S4, the sync property suite for reactions (not held, plans README §6), against the real
 * server: SPEC-013 AC-5 for reactions (sets and clears on comments from several clients, in any
 * interleaving, converge to the server's state, at most 20 emoji per subject, none left on a
 * deleted comment) and AC-22 (reactions on the issue itself, in the same runs), E4 (two people,
 * one emoji) and E5 (one person, one emoji, from a queued repeat).
 *
 * The plan names `reactions.prop.test.ts`; the fake hub runs no operation handlers, so the suite
 * runs on the real server, as the comment suite does (PLAN-013 S3). The 21st-emoji race (E14) is
 * a unit test (`apps/server/test/reaction-set.test.ts`): the steps pick from six emoji, and the
 * property checks that no subject ever holds more than 20.
 */
import fc from 'fast-check';
import { describe, expect, inject, it } from 'vitest';
import { simParameters } from '../src/context.js';
import { reactionConvergence } from '../src/properties.js';
import type { RealServer } from '../src/real-server.js';
import { startRealServer } from '../src/real-server.js';
import type { SimServer } from '../src/server.js';
import { simulate } from '../src/simulate.js';
import type { Case, Step } from '../src/steps.js';
import { reactionCase } from '../src/steps.js';

function reactionServers() {
  let latest: RealServer | undefined;
  const server = async (users: number): Promise<SimServer> => {
    latest = await startRealServer({
      adminUrl: inject('pgAdminUrl'),
      template: inject('pgTemplateDb'),
      users,
    });
    await latest.seedIssueFixtures();
    return latest;
  };
  return { server, last: () => latest };
}

const THUMBS = 0; // 👍 in REACTION_EMOJI
const PARTY = 1; // 🎉

const react = (tab: number, on: 'comment' | 'issue', emoji: number, reacted = true): Step => ({
  t: 'reactionSet',
  tab,
  on,
  target: 0,
  emoji,
  reacted,
});

/**
 * Tab 0 (user 0) comments; both users react 👍 to it (E4: two rows). Tab 1 goes offline and sets
 * 🎉 on the issue twice (E5: the queued repeat changes nothing) while tab 0 sets 🎉 there too.
 * Back online, tab 0 clears its 👍, then deletes its comment, which takes Iris's 👍 with it. The
 * issue keeps both 🎉.
 */
const example: Case = {
  seed: 7,
  users: 2,
  lateUsers: 0,
  webLocks: true,
  steps: [
    { t: 'issueCreate', tab: 0, title: 'Alpha', status: 'default', labels: [] },
    { t: 'wait', ms: 3_000 },
    { t: 'commentCreate', tab: 0, issue: 0, text: 'LGTM' },
    { t: 'wait', ms: 2_000 },
    react(0, 'comment', THUMBS),
    react(1, 'comment', THUMBS),
    { t: 'wait', ms: 2_000 },
    { t: 'offline', tab: 1, ms: 5_000 },
    react(1, 'issue', PARTY),
    react(1, 'issue', PARTY),
    react(0, 'issue', PARTY),
    { t: 'wait', ms: 8_000 },
    react(0, 'comment', THUMBS, false),
    { t: 'wait', ms: 2_000 },
    { t: 'commentDelete', tab: 0, comment: 0 },
    { t: 'wait', ms: 2_000 },
  ],
};

describe('reactions against the real server', () => {
  it('keeps one row per person and emoji, and a deleted comment takes its reactions (E4, E5, AC-22)', async () => {
    const servers = reactionServers();
    const result = await simulate(
      example,
      { ...reactionConvergence.options, server: servers.server },
      async (outcome) => {
        await reactionConvergence.check(outcome);
        const stored = Object.values((await servers.last()?.reactions()) ?? {});
        return {
          outcomes: outcome.world.dispatched
            .filter((d) => d.op === 'reaction.set' || d.op === 'comment.delete')
            .map((d) => `${d.op} ${String(d.outcome?.status)}`),
          stored: stored.map((r) => [r.commentId, r.emoji]),
        };
      },
    );
    expect(result.outcomes).toEqual([
      'reaction.set confirmed',
      'reaction.set confirmed',
      'reaction.set confirmed',
      // The repeat from the offline tab: confirmed, and nothing changed (E5).
      'reaction.set confirmed',
      'reaction.set confirmed',
      'reaction.set confirmed',
      'comment.delete confirmed',
    ]);
    expect(result.stored).toEqual([
      [null, '🎉'],
      [null, '🎉'],
    ]);
  });

  /**
   * `pnpm sim:deep` seed 20261107, path `196:2:6:5:9:16:18:15:14:14:15:8:9:9:9`. User 1's only tab
   * drops its socket under 3 s delays and reacts to Alpha while it redials. The socket counts as
   * online when it opens, but the `subscribed` ack is still on its way, and the reaction waits for
   * Alpha's content, which waits for that ack (SPEC-011 §5.3 step 6, §5.7): it is neither queued
   * nor pending yet. The run must not count as settled until that dispatch is queued and confirmed.
   */
  it('waits for a reaction still waiting on its issue’s content before settling (AC-22)', async () => {
    const servers = reactionServers();
    const redialing: Case = {
      seed: -2147483635,
      users: 3,
      lateUsers: 2,
      webLocks: false,
      steps: [
        { t: 'issueCreate', tab: 0, title: 'Alpha', status: 'default', labels: [] },
        { t: 'issueCreate', tab: 1, title: 'Beta', status: 'default', labels: [] },
        { t: 'wait', ms: 3_000 },
        { t: 'disconnect', tab: 0 },
        {
          t: 'faults',
          faults: { dropRequest: 0, dropResponse: 0, hangResponse: 0, maxDelayMs: 3_000 },
        },
        { t: 'wait', ms: 1_368 },
        react(0, 'issue', THUMBS),
      ],
    };
    const result = await simulate(
      redialing,
      { ...reactionConvergence.options, server: servers.server },
      async (outcome) => {
        await reactionConvergence.check(outcome);
        const stored = Object.values((await servers.last()?.reactions()) ?? {});
        return {
          outcomes: outcome.world.dispatched
            .filter((d) => d.op === 'reaction.set')
            .map((d) => `${d.tab} ${String(d.outcome?.status)}`),
          stored: stored.map((r) => [r.commentId, r.emoji]),
        };
      },
    );
    expect(result.outcomes).toEqual(['user-1/tab-1 confirmed']);
    expect(result.stored).toEqual([[null, '👍']]);
  });

  it('every tab converges on the comments and reactions, which keep §4.2’s rules, after any faults (AC-5, AC-22)', async () => {
    const servers = reactionServers();
    // What the runs changed on the server, so a generator that stops reaching it fails here, not
    // silently. Counted from the outbox: `reaction.added`/`removed` are emitted only when a call
    // inserted or removed a row, so a confirmed no-op (a repeat, or a clear of an emoji the tab
    // didn't hold) counts for nothing.
    const changed = { comment: 0, issue: 0, cleared: 0 };
    await fc.assert(
      fc.asyncProperty(reactionCase(), (simCase) =>
        simulate(
          simCase,
          { ...reactionConvergence.options, server: servers.server },
          async (outcome) => {
            await reactionConvergence.check(outcome);
            const server = servers.last();
            if (server === undefined) throw new Error('no server for this run');
            for (const event of await server.events('reaction.added')) {
              const data = typeof event.data === 'object' && event.data !== null ? event.data : {};
              if (Reflect.get(data, 'commentId') === null) changed.issue += 1;
              else changed.comment += 1;
            }
            changed.cleared += (await server.events('reaction.removed')).length;
          },
        ),
      ),
      simParameters(),
    );
    expect(changed.comment, 'reactions added to comments').toBeGreaterThan(0);
    expect(changed.issue, 'reactions added to issues').toBeGreaterThan(0);
    expect(changed.cleared, 'reactions cleared').toBeGreaterThan(0);
  });
});
