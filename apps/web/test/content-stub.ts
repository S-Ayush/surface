// A store's `content` for tests that mount the issue page but not its comments: the issue's
// content never loads, so the comment slots show only their loading state.
export const NO_CONTENT = {
  state: () => 'loading',
  rows: () => ({}),
  open: () => ({ release: () => undefined }),
};
