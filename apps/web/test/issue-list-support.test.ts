// PLAN-012 S3: the small pieces around the list (collapse state, the load seam, the My issues tab,
// copy wording, the announcer, the nav helpers).
import { describe, expect, it, vi } from 'vitest';
import { Announcer } from '../src/features/issues/announcer.js';
import { readCollapse, writeCollapse } from '../src/features/issues/collapse-state.js';
import { planCopy } from '../src/features/issues/copy-actions.js';
import { routeTeamKey } from '../src/features/issues/IssueNavHost.js';
import {
  lastMyIssuesTab,
  myIssuesPath,
  rememberMyIssuesTab,
} from '../src/features/issues/my-issues-tab.js';
import { teamLoadState } from '../src/features/issues/team-load.js';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe('collapse state (§3.3 item 3)', () => {
  it('round-trips per list key', () => {
    const storage = fakeStorage();
    writeCollapse(storage, 'team:ENG', { a: true, b: false });
    expect(readCollapse(storage, 'team:ENG')).toEqual({ a: true, b: false });
    expect(readCollapse(storage, 'team:DES')).toEqual({});
  });

  it('works without storage, with storage that throws, and with garbage', () => {
    expect(readCollapse(undefined, 'k')).toEqual({});
    expect(() => {
      writeCollapse(undefined, 'k', { a: true });
    }).not.toThrow();
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readCollapse(broken, 'k')).toEqual({});
    expect(() => {
      writeCollapse(broken, 'k', { a: true });
    }).not.toThrow();
    expect(readCollapse(fakeStorage({ 'surface:list-collapse:k': '{"a":1}' }), 'k')).toEqual({});
    expect(readCollapse(fakeStorage({ 'surface:list-collapse:k': 'nope' }), 'k')).toEqual({});
  });
});

describe('team load seam (§3.3 item 10, §7.2)', () => {
  it('renders a member team, or any team the replica holds rows of, at once', () => {
    expect(teamLoadState({ member: true, online: false, hasRows: false })).toBe('loaded');
    expect(teamLoadState({ member: false, online: false, hasRows: true })).toBe('loaded');
  });

  it('says Loading while a non-member team is online, and offline when it never loaded', () => {
    expect(teamLoadState({ member: false, online: true, hasRows: false })).toBe('loading');
    expect(teamLoadState({ member: false, online: false, hasRows: false })).toBe('offline');
  });
});

describe('My issues tab (§3.9 item 1)', () => {
  it('opens Assigned at first, then the tab used last', () => {
    const storage = fakeStorage();
    expect(lastMyIssuesTab(storage)).toBe('assigned');
    rememberMyIssuesTab('created', storage);
    expect(lastMyIssuesTab(storage)).toBe('created');
    expect(myIssuesPath('created')).toBe('/my-issues/created');
    expect(myIssuesPath('assigned')).toBe('/my-issues');
    rememberMyIssuesTab('assigned', storage);
  });

  it('falls back to memory when storage throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    rememberMyIssuesTab('created', broken);
    expect(lastMyIssuesTab(broken)).toBe('created');
    rememberMyIssuesTab('assigned', broken);
    expect(lastMyIssuesTab(broken)).toBe('assigned');
  });
});

describe('Copy › (§3.7)', () => {
  const target = { identifier: 'ENG-42', title: 'Fix login redirect' };
  const origin = 'https://surface.example.com';

  it('copies the ID, URL, title, title as link and branch name with the spec’s toasts', () => {
    expect(planCopy('id', target, origin, 'ada')).toEqual({
      ok: true,
      text: 'ENG-42',
      message: 'Copied ENG-42',
    });
    expect(planCopy('url', target, origin, 'ada')).toEqual({
      ok: true,
      text: 'https://surface.example.com/issue/ENG-42/fix-login-redirect',
      message: 'Copied link to ENG-42',
    });
    expect(planCopy('title', target, origin, 'ada')).toMatchObject({
      text: 'Fix login redirect',
      message: 'Copied title',
    });
    expect(planCopy('title-link', target, origin, 'ada')).toMatchObject({
      text: '[Fix login redirect](https://surface.example.com/issue/ENG-42/fix-login-redirect)',
      message: 'Copied title as link',
    });
    expect(planCopy('branch', target, origin, 'ada')).toMatchObject({
      text: 'ada/eng-42-fix-login-redirect',
      message: 'Copied branch name',
    });
  });

  it('copies nothing for a pending issue', () => {
    const plan = planCopy('id', { identifier: null, title: 'New' }, origin, 'ada');
    expect(plan).toEqual({ ok: false, message: 'Wait a moment: ENG-… has no number yet.' });
  });
});

describe('announcer (§7.4)', () => {
  it('changes its serial on every call so the same text is read twice', () => {
    const announcer = new Announcer();
    const listener = vi.fn();
    const stop = announcer.subscribe(listener);
    announcer.announce('ENG-42 deleted');
    const first = announcer.snapshot();
    announcer.announce('ENG-42 deleted');
    const second = announcer.snapshot();
    expect(first.text).toBe(second.text);
    expect(second.serial).toBe(first.serial + 1);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    announcer.announce('x');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('routeTeamKey (G E, §3.6)', () => {
  it('reads the team from a team page or an issue address', () => {
    expect(routeTeamKey('/team/eng/issues')).toBe('ENG');
    expect(routeTeamKey('/team/ENG')).toBe('ENG');
    expect(routeTeamKey('/issue/des-7/some-title')).toBe('DES');
    expect(routeTeamKey('/my-issues')).toBeUndefined();
    expect(routeTeamKey('/issue/0192f0c1-7e5a')).toBeUndefined();
  });
});
