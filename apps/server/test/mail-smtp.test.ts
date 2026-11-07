// PLAN-001 S4: the mailer against a fake SMTP server on 127.0.0.1 (the unit part of AC-4, a
// held e2e). It sends a multipart text + HTML message from SMTP_FROM, never sends a password
// over plain SMTP, sorts failures into "retry" and "give up", and keeps the password out of
// what it reports (CLAUDE.md rule 6).
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMailer,
  describeSmtpError,
  isPermanentFailure,
  smtpTransportOptions,
} from '../src/mail/smtp.js';
import { renderEmail } from '../src/mail/templates.js';
import { freePort } from './helpers.js';
import { startFakeSmtp, type FakeSmtp } from './fake-smtp.js';

const FROM = 'Surface <surface@example.com>';
const LINK = 'https://surface.example.com/reset?token=reset-token-0123456789abcdef';
const email = {
  to: 'ada@example.com',
  ...renderEmail({ template: 'passwordReset', workspaceName: 'Acme', link: LINK }),
};
const fast = { connectionMs: 2_000, greetingMs: 2_000, socketMs: 2_000 };

let smtp: FakeSmtp | undefined;
afterEach(async () => {
  await smtp?.close();
  smtp = undefined;
});

describe('smtpTransportOptions (SPEC-004 §7 SMTP_URL)', () => {
  it('uses TLS from the first byte for smtps://, on 465 by default', () => {
    const options = smtpTransportOptions({ url: 'smtps://u:p@mail.example.com', from: FROM });
    expect(options).toMatchObject({ host: 'mail.example.com', port: 465, secure: true });
    expect(options.requireTLS).toBe(false);
  });

  it('requires STARTTLS for smtp:// with credentials, on 587 by default', () => {
    const options = smtpTransportOptions({
      url: 'smtp://u%40x:p%3Aw@mail.example.com',
      from: FROM,
    });
    expect(options).toMatchObject({ port: 587, secure: false, requireTLS: true });
    expect(options.auth).toEqual({ user: 'u@x', pass: 'p:w' });
  });

  it('lets an unauthenticated relay speak plain SMTP', () => {
    const options = smtpTransportOptions({ url: 'smtp://[::1]:25', from: FROM });
    expect(options).toMatchObject({ host: '::1', port: 25, secure: false, requireTLS: false });
    expect(options.auth).toBeUndefined();
  });

  it('keeps Nodemailer from logging or loading files and URLs', () => {
    expect(smtpTransportOptions({ url: 'smtp://relay', from: FROM })).toMatchObject({
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  });
});

describe('createMailer', () => {
  it('sends a text + HTML message from SMTP_FROM to the recipient', async () => {
    smtp = await startFakeSmtp();
    const mailer = createMailer({ url: `smtp://127.0.0.1:${smtp.port}`, from: FROM }, fast);
    const outcome = await mailer.send(email);
    mailer.close();

    expect(outcome.ok).toBe(true);
    const [mail] = smtp.messages;
    expect(mail?.from).toBe('surface@example.com');
    expect(mail?.to).toEqual(['ada@example.com']);
    expect(mail?.raw).toMatch(/^From: Surface <surface@example\.com>$/m);
    expect(mail?.raw).toMatch(/^Subject: Reset your password for Acme$/m);
    expect(mail?.raw).toMatch(/^Auto-Submitted: auto-generated$/m);
    expect(mail?.raw).toMatch(/^Content-Type: multipart\/alternative;/m);
    expect(mail?.raw).toMatch(/^Content-Type: text\/plain/m);
    expect(mail?.raw).toMatch(/^Content-Type: text\/html/m);
    expect(mail?.decoded).toContain(`Choose a new password: ${LINK}`);
    expect(mail?.decoded).toContain(`href="${LINK}"`);
  });

  it('never sends the password over plain SMTP: no STARTTLS, no email, retried later', async () => {
    smtp = await startFakeSmtp({ auth: { user: 'surface', pass: 'hunter2-long' } });
    const mailer = createMailer(
      { url: `smtp://surface:hunter2-long@127.0.0.1:${smtp.port}`, from: FROM },
      fast,
    );
    const outcome = await mailer.send(email);
    mailer.close();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.permanent).toBe(false);
    expect(outcome.failure).toMatchObject({ code: 'ETLS', command: 'STARTTLS' });
    expect(smtp.commands).not.toContain('AUTH');
    expect(smtp.messages).toHaveLength(0);
    expect(JSON.stringify(outcome.failure)).not.toContain('hunter2');
  });

  it('gives up on a 5xx refusal of the message', async () => {
    smtp = await startFakeSmtp({ dataReply: '550 5.7.1 Message rejected as spam' });
    const mailer = createMailer({ url: `smtp://127.0.0.1:${smtp.port}`, from: FROM }, fast);
    const outcome = await mailer.send(email);
    mailer.close();

    expect(outcome).toMatchObject({
      ok: false,
      permanent: true,
      failure: { responseCode: 550, command: 'DATA' },
    });
  });

  it('gives up when a recipient is refused for good', async () => {
    smtp = await startFakeSmtp({ rcptReply: '550 5.1.1 Recipient address rejected' });
    const mailer = createMailer({ url: `smtp://127.0.0.1:${smtp.port}`, from: FROM }, fast);
    const outcome = await mailer.send(email);
    mailer.close();

    expect(outcome).toMatchObject({
      ok: false,
      permanent: true,
      failure: { code: 'EENVELOPE', responseCode: 550, command: 'RCPT' },
    });
  });

  it('retries a refused sender: SMTP_FROM or the relay is misconfigured', async () => {
    smtp = await startFakeSmtp({ mailReply: '553 5.7.1 Sender address rejected: not owned' });
    const mailer = createMailer({ url: `smtp://127.0.0.1:${smtp.port}`, from: FROM }, fast);
    const outcome = await mailer.send(email);
    mailer.close();

    expect(outcome).toMatchObject({
      ok: false,
      permanent: false,
      failure: { code: 'EENVELOPE', responseCode: 553, command: 'MAIL' },
    });
  });

  it('retries a 4xx refusal and a server it cannot reach', async () => {
    smtp = await startFakeSmtp({ rcptReply: '450 4.2.1 Mailbox busy, try later' });
    const busy = createMailer({ url: `smtp://127.0.0.1:${smtp.port}`, from: FROM }, fast);
    expect(await busy.send(email)).toMatchObject({ ok: false, permanent: false });
    busy.close();

    const port = await freePort();
    const down = createMailer({ url: `smtp://127.0.0.1:${port}`, from: FROM }, fast);
    const outcome = await down.send(email);
    down.close();
    expect(outcome).toMatchObject({ ok: false, permanent: false, failure: { code: 'ESOCKET' } });
  });
});

describe('isPermanentFailure', () => {
  const failure = (code: string, responseCode: number | undefined, command?: string) => ({
    code,
    ...(responseCode === undefined ? {} : { responseCode }),
    ...(command === undefined ? {} : { command }),
    message: '',
  });

  it('gives up only on a 5xx refusal of a recipient or of the message', () => {
    expect(isPermanentFailure(failure('EENVELOPE', 550, 'RCPT'))).toBe(true);
    expect(isPermanentFailure(failure('EMESSAGE', 554, 'DATA'))).toBe(true);
  });

  it('retries what the operator can fix and what may pass', () => {
    // A wrong SMTP_FROM, or a relay that wants a login.
    expect(isPermanentFailure(failure('EENVELOPE', 553, 'MAIL'))).toBe(false);
    expect(isPermanentFailure(failure('EENVELOPE', 530, 'MAIL'))).toBe(false);
    expect(isPermanentFailure(failure('EAUTH', 535, 'AUTH'))).toBe(false);
    expect(isPermanentFailure(failure('ETLS', 502, 'STARTTLS'))).toBe(false);
    expect(isPermanentFailure(failure('EMESSAGE', 451, 'DATA'))).toBe(false);
    expect(isPermanentFailure(failure('ETIMEDOUT', undefined))).toBe(false);
  });
});

describe('describeSmtpError', () => {
  it('masks the credentials and keeps only the command verb', () => {
    const error = Object.assign(new Error('535 Bad login for surface:hunter2-long'), {
      code: 'EAUTH',
      responseCode: 535,
      command: 'AUTH PLAIN c3VyZmFjZQBodW50ZXIy',
    });
    const failure = describeSmtpError(error, ['surface', 'hunter2-long']);
    expect(failure).toEqual({
      code: 'EAUTH',
      responseCode: 535,
      command: 'AUTH',
      message: '535 Bad login for [redacted]:[redacted]',
    });
  });

  it('copes with things that are not errors', () => {
    expect(describeSmtpError('boom')).toEqual({ message: 'Unknown SMTP error' });
  });
});
