// The archive page's addresses (SPEC-015 §7; PLAN-015 S4). There is no `/trash` page.

/** The team's archive page; `deleted` for its Recently deleted issues tab. */
export const teamArchivePath = (key: string, tab: 'archived' | 'deleted' = 'archived') =>
  `/team/${encodeURIComponent(key)}/archive${tab === 'deleted' ? '/recently-deleted' : ''}`;
