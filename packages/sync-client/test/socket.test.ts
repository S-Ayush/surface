/**
 * The live connection (SPEC-002 §3.6, sync-protocol.md §4.3) against a
 * scripted transport, with manual timers and fixed randomness.
 */
import type { DeltasMessage, ResyncMessage } from '@surface/sync-protocol';
import { CloseCode, encodeSocketMessage } from '@surface/sync-protocol';
import { describe, expect, it, vi } from 'vitest';
import type { SocketHandlers, Verdict } from '../src/socket.js';
import {
  FAILED_CONNECTS_LIMIT,
  SILENCE_LIMIT_MS,
  SyncSocket,
  backoffDelay,
  socketUrl,
} from '../src/socket.js';
import { ManualTimers } from './support/timers.js';

interface Dial {
  readonly url: string;
  readonly handlers: SocketHandlers;
  readonly sent: string[];
  closed: { code: number; reason: string } | undefined;
}

function setup(
  options: {
    random?: number;
    verdict?: (message: DeltasMessage | ResyncMessage) => Verdict;
    failDial?: boolean;
    probe?: () => Promise<boolean>;
  } = {},
) {
  const timers = new ManualTimers();
  const dials: Dial[] = [];
  const onlineListeners = new Set<() => void>();
  const onRevoked = vi.fn();
  const received: (DeltasMessage | ResyncMessage)[] = [];
  let since = 0;
  const socket = new SyncSocket({
    url: () => `ws://surface.test/sync/ws?since=${since}`,
    factory: (url, handlers) => {
      if (options.failDial) throw new Error('refused');
      const dial: Dial = { url, handlers, sent: [], closed: undefined };
      dials.push(dial);
      return {
        send: (data) => dial.sent.push(data),
        close: (code, reason) => {
          dial.closed = { code, reason };
        },
      };
    },
    onMessage: (message) => {
      received.push(message);
      return options.verdict?.(message) ?? 'ok';
    },
    onRevoked,
    timers,
    clock: () => 1_000_000 + timers.now,
    random: () => options.random ?? 0,
    ...(options.probe ? { probe: options.probe } : {}),
    online: {
      subscribe(listener) {
        onlineListeners.add(listener);
        return () => onlineListeners.delete(listener);
      },
    },
  });
  const last = (): Dial => dials.at(-1) ?? expect.fail('no dial');
  return {
    socket,
    timers,
    dials,
    last,
    received,
    onRevoked,
    onlineListeners,
    setSince: (value: number) => {
      since = value;
    },
    goOnline: () => {
      for (const listener of onlineListeners) listener();
    },
  };
}

const deltas: DeltasMessage = {
  t: 'deltas',
  prev: 0,
  packets: [{ id: 1, a: 'D', m: 'DebugItem', mid: '00000000-0000-7000-8000-000000000001' }],
  ack: [],
};
const frame = (message: Parameters<typeof encodeSocketMessage>[0]) => encodeSocketMessage(message);

describe('connection lifecycle', () => {
  it('dials with the URL of the moment and is online once open', () => {
    const t = setup();
    t.setSince(42);
    t.socket.start();
    expect(t.socket.state).toBe('connecting');
    expect(t.last().url).toBe('ws://surface.test/sync/ws?since=42');
    t.last().handlers.onOpen();
    expect(t.socket.state).toBe('online');
  });

  it('answers ping with pong', () => {
    const t = setup();
    t.socket.start();
    t.last().handlers.onOpen();
    t.last().handlers.onMessage(frame({ t: 'ping' }));
    expect(t.last().sent).toEqual([frame({ t: 'pong' })]);
  });

  it('hands deltas and resync messages to the store', () => {
    const t = setup();
    t.socket.start();
    t.last().handlers.onMessage(frame(deltas));
    t.last().handlers.onMessage(frame({ t: 'resync', reason: 'too_old' }));
    expect(t.received).toEqual([deltas, { t: 'resync', reason: 'too_old' }]);
  });

  it('stop closes the connection, cancels every timer and stays down', () => {
    const t = setup();
    t.socket.start();
    t.socket.stop();
    expect(t.last().closed?.code).toBe(1000);
    expect(t.socket.state).toBe('disconnected');
    expect(t.timers.pending).toEqual([]);
    expect(t.onlineListeners.size).toBe(0);
  });

  it('ignores anything a dropped connection still reports', () => {
    const t = setup();
    t.socket.start();
    const old = t.last();
    old.handlers.onClose(1006); // retry scheduled
    t.timers.runNext();
    old.handlers.onOpen();
    old.handlers.onMessage(frame(deltas));
    old.handlers.onClose(1006);
    expect(t.received).toEqual([]);
    expect(t.socket.state).toBe('connecting');
    expect(t.dials).toHaveLength(2);
  });
});

describe('reconnecting (SPEC-002 §3.6)', () => {
  it('backs off from 0.5 s, doubling, to at most 30 s, with jitter', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map((n) => backoffDelay(n, 0))).toEqual([
      500, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000,
    ]);
    expect([0, 1, 5, 10].map((n) => Math.round(backoffDelay(n, 0.999_999)))).toEqual([
      1000, 2000, 30_000, 30_000,
    ]);
  });

  it('waits longer after each failed attempt', () => {
    const t = setup({ failDial: true, random: 0 });
    t.socket.start();
    const delays = [1, 2, 3, 4].map(() => t.timers.runNext());
    expect(delays).toEqual([500, 1000, 2000, 4000]);
    expect(t.socket.state).toBe('offline');
  });

  it('starts the backoff over once a connection proves healthy', () => {
    const t = setup({ random: 0 });
    t.socket.start();
    t.last().handlers.onClose(1006);
    t.timers.runNext(); // 500
    t.last().handlers.onClose(1006);
    expect(t.timers.pending[0]).toBe(1000);
    t.timers.runNext();
    t.last().handlers.onOpen();
    t.last().handlers.onMessage(frame({ t: 'ping' }));
    t.last().handlers.onClose(CloseCode.ServiceRestart);
    expect(t.timers.pending[0]).toBe(500);
  });

  it('does not reset the backoff for a connection that opens and drops at once', () => {
    const t = setup({ random: 0 });
    t.socket.start();
    for (const expected of [500, 1000, 2000]) {
      t.last().handlers.onOpen();
      t.last().handlers.onClose(1006);
      expect(t.timers.pending[0]).toBe(expected);
      t.timers.runNext();
    }
  });

  it('retries at once when the browser comes back online', () => {
    const t = setup({ random: 0 });
    t.socket.start();
    t.last().handlers.onClose(1006);
    t.timers.runNext();
    t.last().handlers.onClose(1006);
    expect(t.socket.state).toBe('offline');
    t.goOnline();
    expect(t.dials).toHaveLength(3);
    expect(t.socket.state).toBe('connecting');
  });

  it('treats 35 s of silence as a dead connection', () => {
    const t = setup({ random: 0 });
    t.socket.start();
    t.last().handlers.onOpen();
    t.timers.advance(SILENCE_LIMIT_MS - 1);
    t.last().handlers.onMessage(frame({ t: 'ping' })); // any message restarts the clock
    t.timers.advance(SILENCE_LIMIT_MS - 1);
    expect(t.last().closed).toBeUndefined();
    t.timers.advance(1);
    expect(t.last().closed).toEqual({ code: 1000, reason: 'silent' });
    expect(t.socket.state).toBe('offline');
  });

  it('drops the connection and retries when the store says so (a gap), or on a malformed frame', () => {
    const t = setup({ verdict: () => 'reconnect' });
    t.socket.start();
    t.last().handlers.onMessage(frame(deltas));
    expect(t.last().closed?.reason).toBe('reconnect');
    expect(t.socket.state).toBe('offline');
    t.timers.runNext();
    t.last().handlers.onMessage('{"t":"deltas"');
    expect(t.last().closed?.reason).toBe('invalid message');
    t.timers.runNext();
    t.last().handlers.onMessage(new Uint8Array([1]));
    expect(t.last().closed?.reason).toBe('invalid message');
  });

  it('stays down when the store pauses it, until started again', () => {
    const t = setup({ verdict: () => 'pause' });
    t.socket.start();
    t.last().handlers.onMessage(frame({ t: 'resync', reason: 'too_old' }));
    expect(t.socket.state).toBe('disconnected');
    expect(t.timers.pending).toEqual([]);
    t.socket.start();
    expect(t.dials).toHaveLength(2);
  });

  it('retryLater drops the connection and redials after the backoff', () => {
    const t = setup({ random: 0 });
    t.socket.start();
    t.socket.retryLater();
    expect(t.last().closed?.reason).toBe('retry');
    expect(t.timers.pending).toEqual([500]);
  });
});

describe('when the state changed (SPEC-005 §8 "Reconnecting > 5 s")', () => {
  it('records the time of each change of state, not of a repeat', () => {
    const t = setup({ random: 0 });
    t.socket.start();
    expect(t.socket.since).toBe(1_000_000);
    t.timers.advance(200);
    t.last().handlers.onOpen();
    expect(t.socket.since).toBe(1_000_200);
    t.timers.advance(300);
    t.last().handlers.onClose(1006);
    expect([t.socket.state, t.socket.since]).toEqual(['offline', 1_000_500]);
    // Dialling again and failing again: offline → connecting → offline.
    t.timers.runNext();
    expect([t.socket.state, t.socket.since]).toEqual(['connecting', 1_001_000]);
    t.timers.advance(50);
    t.last().handlers.onClose(1006);
    expect(t.socket.since).toBe(1_001_050);
    t.socket.stop();
    t.timers.advance(10);
    t.socket.stop(); // already disconnected: no change
    expect([t.socket.state, t.socket.since]).toEqual(['disconnected', 1_001_050]);
  });
});

describe('how long it has been reconnecting (SPEC-005 §8 "Reconnecting > 5 s")', () => {
  it('runs from when the socket stopped being online, across every retry, until it opens', () => {
    const t = setup({ random: 0 });
    expect(t.socket.reconnectingSince).toBeUndefined();
    t.socket.start();
    expect(t.socket.reconnectingSince).toBe(1_000_000);
    t.timers.advance(100);
    t.last().handlers.onOpen();
    expect(t.socket.reconnectingSince).toBeUndefined();
    t.timers.advance(400);
    t.last().handlers.onClose(1006);
    expect(t.socket.reconnectingSince).toBe(1_000_500);
    // Retries (offline → connecting → offline) do not restart it.
    for (let n = 0; n < 4; n += 1) {
      t.timers.runNext();
      expect(t.socket.state).toBe('connecting');
      t.last().handlers.onClose(1006);
      expect(t.socket.reconnectingSince).toBe(1_000_500);
    }
    t.timers.runNext();
    t.last().handlers.onOpen();
    expect(t.socket.reconnectingSince).toBeUndefined();
  });

  it('is cleared when stopped or revoked: neither is reconnecting', () => {
    const t = setup({ random: 0 });
    t.socket.start();
    t.socket.stop();
    expect(t.socket.reconnectingSince).toBeUndefined();
    t.socket.start();
    t.last().handlers.onClose(CloseCode.SessionRevoked);
    expect(t.socket.reconnectingSince).toBeUndefined();
  });
});

/** Settles promise callbacks queued so far (the probe's answer). */
async function settle(): Promise<void> {
  for (let n = 0; n < 5; n += 1) await Promise.resolve();
}

/** A probe the test answers by hand. */
function manualProbe() {
  const calls: ((answered: boolean) => void)[] = [];
  return {
    probe: () => new Promise<boolean>((resolve) => calls.push(resolve)),
    get calls() {
      return calls.length;
    },
    answer: (answered: boolean) => (calls.at(-1) ?? expect.fail('not probed'))(answered),
  };
}

/** Fail `count` attempts in a row, each before it opens. */
function failAttempts(t: ReturnType<typeof setup>, count: number): void {
  for (let n = 0; n < count; n += 1) {
    if (n > 0) t.timers.runNext();
    t.last().handlers.onClose(1006);
  }
}

describe('live updates unavailable needs the server to answer plain HTTP (sync-protocol.md §4.3)', () => {
  it('asks the server after the third failed attempt, and not before', () => {
    const p = manualProbe();
    const t = setup({ random: 0, probe: p.probe });
    t.socket.start();
    failAttempts(t, 2);
    expect(p.calls).toBe(0);
    t.timers.runNext();
    t.last().handlers.onClose(1006);
    expect(p.calls).toBe(1);
  });

  it('never trips while the server does not answer, as during a restart, and asks again at each failure', async () => {
    const p = manualProbe();
    const t = setup({ random: 0, probe: p.probe });
    t.socket.start();
    failAttempts(t, 3);
    for (let n = 1; n <= 4; n += 1) {
      expect(p.calls).toBe(n);
      p.answer(false);
      await settle();
      expect(t.socket.liveUpdatesUnavailable).toBe(false);
      t.timers.runNext();
      t.last().handlers.onClose(1006);
    }
  });

  it('counts a probe that throws as no answer', async () => {
    const t = setup({ random: 0, probe: () => Promise.reject(new Error('offline')) });
    t.socket.start();
    failAttempts(t, 5);
    await settle();
    expect(t.socket.liveUpdatesUnavailable).toBe(false);
  });

  it('trips when the server answers and the attempt that answer starts at once fails too', async () => {
    const p = manualProbe();
    const t = setup({ random: 0, probe: p.probe });
    t.socket.start();
    failAttempts(t, 3);
    const dials = t.dials.length;
    p.answer(true);
    await settle();
    // Not after the backoff: the server is up, so try the upgrade now.
    expect([t.dials.length, t.socket.state]).toEqual([dials + 1, 'connecting']);
    expect(t.socket.liveUpdatesUnavailable).toBe(false);
    t.last().handlers.onClose(1006);
    expect(t.socket.liveUpdatesUnavailable).toBe(true);
    // Still retrying: a fixed proxy is picked up without a reload.
    expect(t.timers.pending).toHaveLength(1);
    t.timers.runNext();
    t.last().handlers.onOpen();
    expect([t.socket.liveUpdatesUnavailable, t.socket.failedConnects]).toEqual([false, 0]);
  });

  it('does not trip for a server back from a restart: the attempt its answer starts opens', async () => {
    const p = manualProbe();
    const t = setup({ random: 0, probe: p.probe });
    t.socket.start();
    failAttempts(t, 3);
    p.answer(true);
    await settle();
    t.last().handlers.onOpen();
    expect(t.socket.liveUpdatesUnavailable).toBe(false);
    // The next outage starts from nothing: three more failures before asking.
    t.last().handlers.onClose(1006);
    expect(p.calls).toBe(1);
  });

  it('ignores an answer that comes after the run of failures ended', async () => {
    const p = manualProbe();
    const t = setup({ random: 0, probe: p.probe });
    t.socket.start();
    failAttempts(t, 3);
    t.goOnline();
    t.last().handlers.onClose(1006);
    const dials = t.dials.length;
    p.answer(true);
    await settle();
    expect(t.dials.length).toBe(dials);
    t.timers.runNext();
    t.last().handlers.onClose(1006);
    expect(t.socket.liveUpdatesUnavailable).toBe(false);
  });

  it('never trips without a probe', () => {
    const t = setup({ random: 0 });
    t.socket.start();
    failAttempts(t, 6);
    expect(t.socket.liveUpdatesUnavailable).toBe(false);
  });
});

describe('live updates unavailable (SPEC-005 §8)', () => {
  it('starts over when the browser comes back online during an attempt', () => {
    const t = setup({ random: 0 });
    t.socket.start();
    failAttempts(t, 3);
    t.timers.runNext();
    expect(t.socket.state).toBe('connecting');
    const dials = t.dials.length;
    t.goOnline();
    expect(t.socket.failedConnects).toBe(0);
    // The attempt under way carries on; no second one.
    expect(t.dials.length).toBe(dials);
  });

  it('starts over when stopped, so a stopped store shows no banner', async () => {
    const p = manualProbe();
    const t = setup({ random: 0, probe: p.probe });
    t.socket.start();
    failAttempts(t, 3);
    p.answer(true);
    await settle();
    t.last().handlers.onClose(1006);
    expect(t.socket.liveUpdatesUnavailable).toBe(true);
    t.socket.stop();
    expect([t.socket.liveUpdatesUnavailable, t.socket.failedConnects]).toEqual([false, 0]);
  });

  it('counts attempts in a row that close before opening, and starts over once one opens', () => {
    const t = setup({ random: 0 });
    t.socket.start();
    for (const expected of [1, 2, 3]) {
      t.last().handlers.onClose(1006);
      expect(t.socket.failedConnects).toBe(expected);
      t.timers.runNext();
    }
    expect(FAILED_CONNECTS_LIMIT).toBe(3);
    t.last().handlers.onOpen();
    expect(t.socket.failedConnects).toBe(0);
  });

  it('counts an attempt the browser refuses outright', () => {
    const t = setup({ failDial: true, random: 0 });
    t.socket.start();
    expect(t.socket.failedConnects).toBe(1);
    t.timers.runNext();
    t.timers.runNext();
    expect(t.socket.failedConnects).toBe(3);
  });

  it('counts an upgrade that hangs until the silence watchdog gives up', () => {
    const t = setup({ random: 0 });
    t.socket.start();
    t.timers.advance(SILENCE_LIMIT_MS);
    expect(t.last().closed?.reason).toBe('silent');
    expect(t.socket.failedConnects).toBe(1);
  });

  it('does not count a connection that opened and then dropped or went silent', () => {
    const t = setup({ random: 0 });
    t.socket.start();
    t.last().handlers.onOpen();
    t.last().handlers.onClose(1006);
    t.timers.runNext();
    t.last().handlers.onOpen();
    t.timers.advance(SILENCE_LIMIT_MS);
    expect(t.last().closed?.reason).toBe('silent');
    expect(t.socket.failedConnects).toBe(0);
  });

  it('does not count an attempt given up on purpose (stop, retryLater, a revoked session)', () => {
    const t = setup({ random: 0 });
    t.socket.start();
    t.socket.retryLater();
    t.timers.runNext();
    t.socket.stop();
    t.socket.start();
    t.last().handlers.onClose(CloseCode.SessionRevoked);
    expect(t.socket.failedConnects).toBe(0);
  });

  it('starts over when the browser comes back online: the network was down, not the proxy', () => {
    const t = setup({ random: 0 });
    t.socket.start();
    for (let n = 0; n < 3; n += 1) {
      t.last().handlers.onClose(1006);
      t.timers.runNext();
    }
    t.last().handlers.onClose(1006);
    expect(t.socket.failedConnects).toBe(4);
    t.goOnline();
    expect(t.socket.failedConnects).toBe(0);
  });
});

describe('a revoked session (E10)', () => {
  it('is recognised on a new connection closed with 4001 before any message (revoked while offline)', () => {
    const t = setup();
    t.socket.start();
    t.last().handlers.onClose(1006);
    t.timers.runNext();
    t.last().handlers.onClose(CloseCode.SessionRevoked);
    expect(t.socket.state).toBe('revoked');
    expect(t.onRevoked).toHaveBeenCalledOnce();
    expect(t.timers.pending).toEqual([]);
  });

  it('stops reconnecting for good and says so once', () => {
    const t = setup();
    t.socket.start();
    t.last().handlers.onOpen();
    t.last().handlers.onClose(CloseCode.SessionRevoked);
    expect(t.socket.state).toBe('revoked');
    expect(t.onRevoked).toHaveBeenCalledOnce();
    expect(t.timers.pending).toEqual([]);
    t.goOnline();
    expect(t.dials).toHaveLength(1);
  });

  it('is not undone by a later retry (review S7 n1)', () => {
    const t = setup();
    t.socket.start();
    t.last().handlers.onClose(CloseCode.SessionRevoked);
    t.socket.retryLater(); // e.g. a resync that failed after the revoke
    expect(t.socket.state).toBe('revoked');
    expect(t.timers.pending).toEqual([]);
    t.goOnline();
    expect(t.dials).toHaveLength(1);
    expect(t.onRevoked).toHaveBeenCalledOnce();
  });
});

describe('a connection that opens at once (review S7 n2)', () => {
  it('is closed, not kept, when the socket is stopped while it opens', () => {
    const closed: number[] = [];
    const socket: SyncSocket = new SyncSocket({
      url: () => 'ws://surface.test/sync/ws',
      factory: (_url, handlers) => {
        handlers.onOpen(); // a transport that opens synchronously
        return { send: () => undefined, close: (code) => closed.push(code) };
      },
      onMessage: () => 'ok',
      onRevoked: () => undefined,
      onOpen: () => socket.stop(),
      timers: new ManualTimers(),
    });
    socket.start();
    expect(socket.state).toBe('disconnected');
    expect(closed).toEqual([1000]);
  });
});

describe('socket URL', () => {
  it('turns the server address into a ws(s) URL with the query', () => {
    expect(socketUrl('http://surface.lan:8080/', '/sync/ws', 'since=1')).toBe(
      'ws://surface.lan:8080/sync/ws?since=1',
    );
    expect(socketUrl('https://surface.example.com/base', '/sync/ws', 'since=1')).toBe(
      'wss://surface.example.com/base/sync/ws?since=1',
    );
  });

  it('needs an absolute address where there is no page origin', () => {
    expect(() => socketUrl('', '/sync/ws', 'since=1')).toThrow();
  });
});
