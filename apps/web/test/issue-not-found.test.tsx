/**
 * @vitest-environment jsdom
 */
// SPEC-012 §3.4 item 7, AC-15: the not-found page is the same markup for an unknown number in a team
// the user can see, an unknown team key, and a private team's key. Rendered through `IssuePage`, with
// `issue.get` answering `NOT_FOUND` as the server does for all three.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { notFoundSubject } from '../src/features/issues/IssueNotFound.js';
import { FakeApp, installDomShims, mountIssuePage, type Mounted } from './issue-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(installDomShims);

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const notFound = {
  get: () => Promise.resolve({ ok: false, code: 'NOT_FOUND', message: 'No such issue.' } as const),
};

async function render(app: FakeApp, ref: string): Promise<string> {
  await mounted?.unmount();
  mounted = await mountIssuePage({ app, ref, api: notFound });
  // The answer arrives after the first render.
  await mounted.router.invalidate();
  return mounted.host.innerHTML;
}

describe('the not-found page (AC-15)', () => {
  it('is identical for an unknown number, an unknown team key and a private team’s key', async () => {
    const heldTeam = await render(new FakeApp({ issues: [] }), 'ENG-99');
    const unknownKey = await render(new FakeApp({ issues: [], teams: [] }), 'ENG-99');
    // A private team the user isn't in is not in their replica: the same replica as an unknown key.
    const privateKey = await render(new FakeApp({ issues: [], teams: [] }), 'PRV-99');
    expect(heldTeam).toContain("ENG-99 doesn't exist, or you don't have access to it.");
    expect(unknownKey).toBe(heldTeam);
    expect(privateKey.replaceAll('PRV-99', 'ENG-99')).toBe(heldTeam);
    // Always "Go home", never a link to a team, which would say which keys exist.
    expect(heldTeam).toContain('Go home');
    expect(heldTeam).not.toContain('issues</button>');
    expect(heldTeam).not.toContain('Engineering');
  });

  it('says "This issue" for an id and names only what was typed otherwise', () => {
    expect(notFoundSubject('0192f0c1-7e5a-7b3c-9d4e-0000000000b1')).toBe('This issue');
    expect(notFoundSubject('eng-99')).toBe('ENG-99');
  });
});
