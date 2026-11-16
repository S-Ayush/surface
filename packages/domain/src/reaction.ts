/**
 * Reaction rules shared by the server handler, the outputs and the client (SPEC-013 §4.2, §6.1,
 * §6.3, D15). A reaction is on a comment or, with no comment, on the issue itself (D8). Its id is
 * `reactionId(subject, user, emoji)` (`doc.ts`), so the optimistic row and the server's row match.
 */

/** At most this many distinct emoji per subject: one comment, or the issue itself (D15). */
export const REACTION_EMOJI_LIMIT = 20;

/** The SPEC-013 §6.3 sentences, so the server, the client and the tests use the same words. */
export const REACTION_MESSAGES = {
  notOneEmoji: 'Use a single emoji, like 👍.',
  tooMany: `You can add at most ${String(REACTION_EMOJI_LIMIT)} different reactions here.`,
  subject: 'React to a comment or to the issue, not both.',
} as const;

/** What the reaction rules read of a stored reaction, on either side. */
export interface ReactionRowFacts {
  readonly userId: string;
  readonly emoji: string;
  /** A `Date` on the server, an ISO string in the client replica. */
  readonly createdAt?: Date | string | null | undefined;
}

/** One chip: an emoji on a subject, how many people set it, and whether the viewer did. */
export interface ReactionSummary {
  readonly emoji: string;
  readonly count: number;
  readonly mine: boolean;
}

const timeOf = (value: ReactionRowFacts['createdAt']): number => {
  if (value === null || value === undefined) return Number.POSITIVE_INFINITY;
  const time = typeof value === 'string' ? Date.parse(value) : value.getTime();
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
};

/**
 * The chips of one subject's reactions (SPEC-013 §3.4, §6.1; `CommentOutput.reactions` and
 * `IssueOutput.reactions`): one per emoji, in the order the emoji was first set (then by emoji, so
 * the order is total), with `mine` when `userId` set it. Rows of other subjects must be left out
 * by the caller.
 */
export function summariseReactions(
  rows: readonly ReactionRowFacts[],
  userId: string | null | undefined,
): ReactionSummary[] {
  const byEmoji = new Map<string, { first: number; count: number; mine: boolean }>();
  for (const row of rows) {
    const time = timeOf(row.createdAt);
    const entry = byEmoji.get(row.emoji);
    const mine = userId !== null && userId !== undefined && row.userId === userId;
    if (entry === undefined) {
      byEmoji.set(row.emoji, { first: time, count: 1, mine });
    } else {
      entry.first = Math.min(entry.first, time);
      entry.count += 1;
      entry.mine ||= mine;
    }
  }
  return [...byEmoji]
    .sort(([a, x], [b, y]) => x.first - y.first || (a < b ? -1 : a > b ? 1 : 0))
    .map(([emoji, { count, mine }]) => ({ emoji, count, mine }));
}

/**
 * Why setting `emoji` on a subject that holds `rows` is refused by the cap (D15, E14, E25), or
 * undefined. An emoji the subject already carries never counts again.
 */
export function reactionCapProblem(
  rows: readonly Pick<ReactionRowFacts, 'emoji'>[],
  emoji: string,
): string | undefined {
  const distinct = new Set(rows.map((row) => row.emoji));
  if (distinct.has(emoji) || distinct.size < REACTION_EMOJI_LIMIT) return undefined;
  return REACTION_MESSAGES.tooMany;
}
