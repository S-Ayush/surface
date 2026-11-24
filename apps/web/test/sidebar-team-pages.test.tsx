/**
 * @vitest-environment jsdom
 */
// PLAN-015 S4 (SPEC-015 §3.3, PLAN-012 S3): an expanded team in the sidebar lists its pages, with
// the team's Archive page (the page `G` `X` opens) after Issues and Home.
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import type { TeamSummary } from '../src/command-menu/model.js';
import { ShortcutProvider } from '../src/shortcuts/ShortcutProvider.js';
import { ShellContext } from '../src/shell/ShellContext.js';
import { ShellStore } from '../src/shell/ShellStore.js';
import { Sidebar } from '../src/shell/Sidebar.js';

const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';

/** Only the teams the sidebar lists; no store. */
class TeamsApp extends AppModel {
  readonly #teams: TeamSummary[];
  constructor(teams: TeamSummary[]) {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
    this.#teams = teams;
  }
  override teams = (): TeamSummary[] => this.#teams;
}

async function render(shell: ShellStore): Promise<HTMLElement> {
  const app = new TeamsApp([{ id: ENG, key: 'ENG', name: 'Engineering' }]);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Sidebar width={240} autoFocus={false} /> }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  const host = document.createElement('div');
  host.innerHTML = renderToString(
    <AppContext value={app}>
      <ShellContext value={shell}>
        <ShortcutProvider>
          <RouterProvider router={router} />
        </ShortcutProvider>
      </ShellContext>
    </AppContext>,
  );
  return host;
}

describe('the sidebar team pages', () => {
  it("lists Issues, Home and the team's Archive page once the team is expanded", async () => {
    const shell = new ShellStore(null);
    shell.toggleTeam(ENG);
    const host = await render(shell);
    const pages = [...host.querySelectorAll<HTMLAnchorElement>(`#sidebar-team-${ENG} a`)];
    expect(pages.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Issues', '/team/ENG/issues'],
      ['Home', '/team/ENG'],
      ['Archive', '/team/ENG/archive'],
    ]);
    const archive = pages.at(-1);
    expect(archive?.getAttribute('aria-label')).toBe('Engineering archive');
  });

  it('shows no team pages while the team is collapsed', async () => {
    const host = await render(new ShellStore(null));
    expect(host.querySelector(`#sidebar-team-${ENG}`)).toBeNull();
    expect(host.textContent).not.toContain('Archive');
  });
});
