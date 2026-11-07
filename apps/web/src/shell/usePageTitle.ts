// The page title (SPEC-005 §6 focus rules): inside the shell, a new title is announced.
import { use, useEffect } from 'react';
import { ShellContext } from './ShellContext.js';

export const titleFor = (page: string) => `${page} · Surface`;

export function usePageTitle(page: string): void {
  const shell = use(ShellContext);
  useEffect(() => {
    const title = titleFor(page);
    document.title = title;
    shell?.showTitle(title);
  }, [page, shell]);
}
