/**
 * The live connection (SPEC-002 §3.6, sync-protocol.md §4.3) against a
 * scripted transport, with manual timers and fixed randomness.
 */
import type { DeltasMessage, ResyncMessage } from '@surface/sync-protocol';
import { CloseCode, encodeSocketMessage } from '@surface/sync-protocol';
import { describe, expect, it, vi } from 'vitest';
import type { SocketHandlers, Verdict } from '../src/socket.js';
import { SILENCE_LIMIT_MS, SyncSocket, backoffDelay, socketUrl } from '../src/socket.js';
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
    random: () => options.random ?? 0,
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
