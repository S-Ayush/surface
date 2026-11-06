// SPEC-004 §10 / AC-11: secrets, tokens and cookies never reach the logs.
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, REDACTED, redactUrl } from '../src/logger.js';
import { captureLogs, testApp, type TestApp } from './helpers.js';

describe('redactUrl', () => {
  it.each([
    ['/auth/magic?token=abc123', `/auth/magic?token=${REDACTED}`],
    ['/auth/reset?next=/x&TOKEN=abc', `/auth/reset?next=/x&TOKEN=${REDACTED}`],
    [
      '/auth/x?code=1&key=2&secret=3&password=4',
      `/auth/x?code=${REDACTED}&key=${REDACTED}&secret=${REDACTED}&password=${REDACTED}`,
    ],
    ['/invite/inv_9f8e7d', `/invite/${REDACTED}`],
    ['/api/invite/inv_9f8e7d/accept', `/api/invite/${REDACTED}/accept`],
    ['/team/ENG/issues?filter=open', '/team/ENG/issues?filter=open'],
    ['/healthz', '/healthz'],
    ['/a?flag&token', '/a?flag&token'],
  ])('%s → %s', (input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });
});

describe('log redaction', () => {
  it('censors sensitive keys at any of the first three levels', () => {
    const logs = captureLogs();
    const log = createLogger({ logLevel: 'info' }, logs.stream);
    log.info(
      {
        password: 'pw-top',
        user: { email: 'a@b.c', password: 'pw-nested', token: 'tok-nested' },
        body: { auth: { newPassword: 'pw-deep', apiKey: 'key-deep' } },
        sessionSecret: 'sess',
      },
      'event',
    );
    const text = logs.text();
    for (const secret of ['pw-top', 'pw-nested', 'tok-nested', 'pw-deep', 'key-deep', 'sess"']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('a@b.c');
    expect(logs.lines[0]).toMatchObject({ level: 'info', msg: 'event', password: REDACTED });
  });

  describe('request logs', () => {
    let t: TestApp;
    afterEach(async () => {
      await t.app.close();
    });

    it('masks tokens in URLs and never logs cookies or authorization headers', async () => {
      t = await testApp();
      await t.app.inject({
        url: '/auth/magic?token=magic-secret-1',
        headers: {
          cookie: 'surface_session=cookie-secret-2',
          authorization: 'Bearer bearer-secret-3',
        },
      });
      const text = t.logs.text();
      expect(text).toContain(`/auth/magic?token=${REDACTED}`);
      for (const secret of ['magic-secret-1', 'cookie-secret-2', 'bearer-secret-3']) {
        expect(text).not.toContain(secret);
      }
      expect(t.logs.lines.find((l) => l.msg === 'incoming request')).toHaveProperty('reqId');
    });
  });
});
