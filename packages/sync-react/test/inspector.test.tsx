/**
 * The sync inspector's markup (SPEC-002 §5.4), rendered on the server in Node.
 * Clicking "Force resync" needs a browser and waits for the e2e hold; AC-13
 * is the manual check during AC-6.
 */
import type { InspectorSnapshot } from '@surface/sync-client';
import { SyncStore } from '@surface/sync-client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InspectorView, SyncInspector } from '../src/SyncInspector.js';
import { SyncStoreProvider } from '../src/context.js';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const ROW = '00000000-0000-7000-8000-000000000001';

const busy: InspectorSnapshot = {
  status: 'ready',
  error: undefined,
  connection: {
    state: 'online',
    since: NOW - 12_000,
    reconnectingSince: undefined,
    liveUpdatesUnavailable: false,
  },
  clientId: '0190f4c4-0000-7000-8000-00000000c11e',
  lastSyncId: 4217,
  persistent: true,
  storageWarning: undefined,
  pending: [
    { seq: 57, op: 'team.update', at: new Date(NOW - 3000).toISOString(), state: 'sent' },
    { seq: 58, op: 'user.updateProfile', at: new Date(NOW - 500).toISOString(), state: 'queued' },
  ],
  roundTrip: { op: 'team.update', seq: 56, ms: 84 },
  packets: [
    { id: 4217, action: 'A', model: 'Team', rowId: ROW, appliedAt: NOW - 2000 },
    { id: 4216, action: 'U', model: 'Team', rowId: ROW, appliedAt: NOW - 120_000 },
  ],
  rejections: [
    { op: 'team.update', seq: 55, input: {}, code: 'NOT_FOUND', message: 'Team not found.' },
  ],
  rows: [
    { model: 'Team', count: 12 },
    { model: 'User', count: 40 },
  ],
};

function render(snapshot: InspectorSnapshot, usage?: number, resyncing = false): string {
  return renderToStaticMarkup(
    <InspectorView
      snapshot={snapshot}
      now={NOW}
      usage={usage}
      resyncing={resyncing}
      onResync={() => undefined}
    />,
  );
}

/** The markup as text, one space between elements, for readable assertions. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the panel shows everything SPEC-002 §5.4 lists', () => {
  it('state, position, lag, storage, queue, packets, rejections and rows', () => {
    const shown = text(render(busy, 1.5 * 1024 * 1024));
    for (const expected of [
      'Status ready',
      'Connection online for 12 s',
      'lastSyncId 4217',
      'Client 0190f4c4-0000-7000-8000-00000000c11e',
      'Server lag 84 ms (team.update #56)',
      'Storage IndexedDB · 1.5 MB used by this site',
      // Pending: seq, op, state, age.
      'Pending 2 Seq Operation State Age 57 team.update sent 3 s 58 user.updateProfile queued 500 ms',
      // Packets: newest first, with what happened, not the row.
      `Recent packets 2 Id Action Model Row Age 4217 archive Team ${ROW} 2 s 4216 update Team ${ROW} 2 min`,
      'Rejections 1 Seq Operation Code Message 55 team.update NOT_FOUND Team not found.',
      'Rows Model Rows Team 12 User 40',
    ]) {
      expect(shown).toContain(expected);
    }
  });

  it('is a labelled region with a "Force resync" button that shows when it is busy', () => {
    const idle = render(busy);
    expect(idle).toMatch(/^<section[^>]*aria-label="Sync inspector"/);
    expect(idle).toMatch(/<button[^>]*>.*Force resync.*<\/button>/);
    expect(idle).not.toContain('aria-busy="true"');
    expect(render(busy, undefined, true)).toContain('aria-busy="true"');
  });

  it('says what is wrong: a failed start, blocked live updates, storage that will not survive', () => {
    const shown = text(
      render({
        ...busy,
        status: 'failed',
        error: 'The server did not answer within 30 seconds. Check your connection and try again.',
        connection: {
          state: 'offline',
          since: NOW - 3_000,
          reconnectingSince: NOW - 45_000,
          liveUpdatesUnavailable: true,
        },
        persistent: false,
        storageWarning: 'Offline mode unavailable in this browser session',
      }),
    );
    expect(shown).toContain(
      'Status failed · The server did not answer within 30 seconds. Check your connection and try again.',
    );
    expect(shown).toContain(
      'Connection offline for 3 s · reconnecting for 45 s · live updates look blocked by a proxy',
    );
    expect(shown).toContain(
      'Storage Memory only · Offline mode unavailable in this browser session',
    );
  });

  it('says so when a list is empty, and before any change is confirmed', () => {
    const shown = text(
      render({
        ...busy,
        lastSyncId: undefined,
        pending: [],
        roundTrip: undefined,
        packets: [],
        rejections: [],
        rows: [],
      }),
    );
    for (const expected of [
      'lastSyncId none',
      'Server lag No change confirmed yet',
      'Pending 0 Nothing waiting for the server.',
      'Recent packets 0 No change received yet.',
      'Rejections 0 The server has rejected nothing.',
      'Rows No models.',
    ]) {
      expect(shown).toContain(expected);
    }
  });
});

describe('the panel on a store', () => {
  it('reads the store from the provider', () => {
    const store = new SyncStore({
      models: [],
      workspaceId: 'ws',
      userId: 'user-1',
      clientId: '0190f4c4-0000-7000-8000-00000000c11e',
      fetch: () => Promise.reject(new Error('not used: the store is never started')),
      locks: null,
      connection: { online: { subscribe: () => () => undefined } },
    });
    const shown = text(
      renderToStaticMarkup(
        <SyncStoreProvider store={store}>
          <SyncInspector />
        </SyncStoreProvider>,
      ),
    );
    expect(shown).toContain('Status idle');
    expect(shown).toContain('Connection disconnected for');
    expect(shown).toContain('Client 0190f4c4-0000-7000-8000-00000000c11e');
    expect(shown).toContain('Storage Not open');
  });
});
