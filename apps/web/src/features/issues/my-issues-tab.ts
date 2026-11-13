// The My issues tab the user used last (SPEC-012 §3.9 item 1): `G` `M` opens it, Assigned at
// first. Kept per device; storage can be missing or throw, so the last tab then lives in memory.
export type MyIssuesTab = 'assigned' | 'created';

const KEY = 'surface:my-issues-tab';
let remembered: MyIssuesTab = 'assigned';

export const myIssuesPath = (tab: MyIssuesTab) =>
  tab === 'created' ? '/my-issues/created' : '/my-issues';

export function rememberMyIssuesTab(
  tab: MyIssuesTab,
  storage: Pick<Storage, 'setItem'> | undefined = safeStorage(),
): void {
  remembered = tab;
  try {
    storage?.setItem(KEY, tab);
  } catch {
    // Kept in memory only.
  }
}

export function lastMyIssuesTab(
  storage: Pick<Storage, 'getItem'> | undefined = safeStorage(),
): MyIssuesTab {
  try {
    const value = storage?.getItem(KEY);
    if (value === 'assigned' || value === 'created') return value;
  } catch {
    // Fall back to memory.
  }
  return remembered;
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
