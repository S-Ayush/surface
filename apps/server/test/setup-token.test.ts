// PLAN-001 S2, SPEC-001 §3.1: the setup token, the link logged at startup, and
// `surface setup-token`. The token gates who becomes the first Admin, so it must be unguessable,
// stored only as a hash and compared in constant time.
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { setupTokenCommand } from '../src/cli/setup-token.js';
import { announceSetup } from '../src/setup/announce.js';
import {
  generateSetupToken,
  hashSetupToken,
  setupTokenMatches,
  setupUrl,
} from '../src/setup/token.js';
import { captureLogs, testConfig } from './helpers.js';

/** A setup state in memory: the stored hash and whether setup is done. */
class FakeSetupState {
  tokenHash: string | null = null;
  complete = false;
  isComplete = () => Promise.resolve(this.complete);
  issueToken = (token: string) => {
    if (this.complete) return Promise.resolve(false);
    this.tokenHash = hashSetupToken(token);
    return Promise.resolve(true);
  };
}

describe('setup token', () => {
  it('is 160 random bits in readable groups, different every time', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateSetupToken));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      // 32 base32 characters × 5 bits = 160 bits, without I, L, O or U.
      expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
    }
  });

  it('uses every symbol of its alphabet, so no bits are lost', () => {
    const seen = new Set(
      Array.from({ length: 200 }, generateSetupToken).join('').replace(/-/g, ''),
    );
    expect(seen.size).toBe(32);
  });

  it('matches only its own hash, and nothing once the hash is cleared', () => {
    const token = generateSetupToken();
    const stored = hashSetupToken(token);
    expect(stored).not.toContain(token);
    expect(setupTokenMatches(stored, token)).toBe(true);
    expect(setupTokenMatches(stored, ` ${token} `)).toBe(true); // pasted with spaces
    expect(setupTokenMatches(stored, generateSetupToken())).toBe(false);
    expect(setupTokenMatches(stored, '')).toBe(false);
    expect(setupTokenMatches(null, token)).toBe(false);
  });

  it('builds the link on SURFACE_URL', () => {
    expect(setupUrl('https://surface.example.com', 'ABCD-EFGH')).toBe(
      'https://surface.example.com/setup?token=ABCD-EFGH',
    );
  });
});

describe('the setup link at startup (AC-1, unit part)', () => {
  it('is logged while setup is incomplete, and its token is the one stored', async () => {
    const state = new FakeSetupState();
    const logs = captureLogs();
    const log = pino({ level: 'info' }, logs.stream);
    const url = await announceSetup(state, {
      publicUrl: 'https://surface.example.com',
      configuredToken: undefined,
      log,
    });
    const token = new URL(url ?? '').searchParams.get('token') ?? '';
    expect(setupTokenMatches(state.tokenHash, token)).toBe(true);
    const line = logs.lines.find((l) => String(l['msg']).includes('/setup?token='));
    expect(line?.['level']).toBe(40); // warn: shown even with LOG_LEVEL=warn
    expect(String(line?.['msg'])).toContain(url);
    expect(line?.['setupUrl']).toBe(url); // `docker compose logs app | grep setupUrl`
  });

  it('uses SURFACE_SETUP_TOKEN when the operator set one', async () => {
    const state = new FakeSetupState();
    const configured = 'my-fixed-setup-token-123';
    const url = await announceSetup(state, {
      publicUrl: 'https://surface.example.com',
      configuredToken: configured,
      log: pino({ level: 'silent' }),
    });
    expect(url).toBe(`https://surface.example.com/setup?token=${configured}`);
    expect(setupTokenMatches(state.tokenHash, configured)).toBe(true);
  });

  it('logs nothing and stores nothing once setup is complete', async () => {
    const state = new FakeSetupState();
    state.complete = true;
    const logs = captureLogs();
    const url = await announceSetup(state, {
      publicUrl: 'https://surface.example.com',
      configuredToken: undefined,
      log: pino({ level: 'info' }, logs.stream),
    });
    expect([url, state.tokenHash, logs.lines]).toEqual([undefined, null, []]);
  });
});

describe('surface setup-token', () => {
  async function run(state: FakeSetupState, setupToken?: string) {
    let out = '';
    let err = '';
    const code = await setupTokenCommand(
      { out: (t) => (out += t), err: (t) => (err += t) },
      testConfig({ setupToken }),
      { store: state },
    );
    return { code, out, err };
  }

  it('prints a fresh link and replaces the stored token', async () => {
    const state = new FakeSetupState();
    await state.issueToken('the-old-setup-token');
    const { code, out, err } = await run(state);
    expect([code, err]).toEqual([0, '']);
    const token = /\/setup\?token=([A-Z0-9-]+)/.exec(out)?.[1] ?? '';
    expect(setupTokenMatches(state.tokenHash, token)).toBe(true);
    expect(setupTokenMatches(state.tokenHash, 'the-old-setup-token')).toBe(false);
    expect(out).toContain('Earlier setup links no longer work');
  });

  it('says the SURFACE_SETUP_TOKEN link stops working until the server restarts', async () => {
    const { code, out } = await run(new FakeSetupState(), 'my-fixed-setup-token-123');
    expect(code).toBe(0);
    expect(out).toContain(
      'Earlier setup links, including the one for SURFACE_SETUP_TOKEN, no longer work until the server restarts',
    );
  });

  it('refuses once setup is complete, pointing to sign-in', async () => {
    const state = new FakeSetupState();
    state.complete = true;
    const { code, out, err } = await run(state);
    expect([code, out]).toEqual([1, '']);
    expect(err).toContain('Setup is already complete. Sign in at https://surface.example.com');
  });
});
