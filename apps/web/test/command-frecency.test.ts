import { describe, expect, it } from 'vitest';
import { FRECENCY_KEY_PREFIX, Frecency } from '../src/command-menu/frecency.js';

const DAY = 86_400_000;

function memory() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe('frecency', () => {
  it('boosts commands that were run, more with use, less with age', () => {
    let now = 1_000 * DAY;
    const storage = memory();
    const frecency = new Frecency({ storage, userId: 'u1', now: () => now });
    expect(frecency.boost('a')).toBe(1);
    frecency.record('a');
    const once = frecency.boost('a');
    frecency.record('a');
    frecency.record('a');
    expect(once).toBeGreaterThan(1);
    expect(frecency.boost('a')).toBeGreaterThan(once);
    const fresh = frecency.boost('a');
    now += 28 * DAY;
    expect(frecency.boost('a')).toBeCloseTo(1 + (fresh - 1) / 4);
  });

  it('is kept per user in localStorage', () => {
    const storage = memory();
    new Frecency({ storage, userId: 'u1' }).record('a');
    expect(storage.data.has(`${FRECENCY_KEY_PREFIX}u1`)).toBe(true);
    expect(new Frecency({ storage, userId: 'u1' }).boost('a')).toBeGreaterThan(1);
    expect(new Frecency({ storage, userId: 'u2' }).boost('a')).toBe(1);
  });

  it('keeps the 200 most recently run commands', () => {
    let now = 1_000 * DAY;
    const storage = memory();
    const frecency = new Frecency({ storage, userId: 'u1', now: () => now });
    for (let i = 0; i <= 200; i++) {
      now += 1;
      frecency.record(`c${i}`);
    }
    expect(frecency.boost('c0')).toBe(1); // the oldest went
    expect(frecency.boost('c1')).toBeGreaterThan(1);
    expect(frecency.boost('c200')).toBeGreaterThan(1);
    const stored = storage.data.get(`${FRECENCY_KEY_PREFIX}u1`) ?? '{}';
    expect(Object.keys(JSON.parse(stored) as object)).toHaveLength(200);
  });

  it('ignores unreadable data and works without storage', () => {
    const storage = memory();
    storage.data.set(`${FRECENCY_KEY_PREFIX}u1`, '{"a":{"count":"lots"}}');
    expect(new Frecency({ storage, userId: 'u1' }).boost('a')).toBe(1);
    storage.data.set(`${FRECENCY_KEY_PREFIX}u1`, 'not json');
    expect(new Frecency({ storage, userId: 'u1' }).boost('a')).toBe(1);
    const none = new Frecency({ storage: null, userId: null });
    none.record('a');
    expect(none.boost('a')).toBeGreaterThan(1);
  });
});
