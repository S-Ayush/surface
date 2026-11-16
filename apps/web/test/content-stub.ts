// A store's `content` for tests that mount the issue page but not its comments: the issue's
// content never loads, so the comment slots show only their loading state.
export const NO_CONTENT = {
  state: () => 'loading',
  rows: () => ({}),
  open: () => ({ release: () => undefined }),
  // Prefetch (PLAN-011 S7) does nothing here.
  prefetch: () => undefined,
  prefetchList: () => undefined,
  prefetchOnHover: () => () => undefined,
};

/**
 * A store's `content` that records the list prefetches (SPEC-011 §5.4, PLAN-011 S7): the latest
 * ids per slot, and the issues hovered.
 */
export function recordingContent() {
  const lists = new Map<string, readonly string[]>();
  const hovered: string[] = [];
  return {
    ...NO_CONTENT,
    lists,
    hovered,
    prefetchList: (slot: string, issueIds: readonly string[]) => {
      lists.set(slot, issueIds);
    },
    prefetchOnHover: (issueId: string) => {
      hovered.push(issueId);
      return () => undefined;
    },
  };
}
