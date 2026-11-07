/**
 * The mailer (PLAN-001 S4, ADR-0007): Nodemailer over the operator's own SMTP server, the one
 * outbound connection Surface makes (CLAUDE.md rule 5). Sending happens only in the `email-send`
 * job (`job.ts`), never inside a request.
 *
 * `SMTP_URL` (SPEC-004 §7): `smtps://` is TLS from the first byte (port 465 by default);
 * `smtp://` upgrades with STARTTLS (port 587 by default). When the URL carries a user name the
 * upgrade is required, so the password never crosses an unencrypted connection; an
 * unauthenticated relay (a local Postfix, Mailpit) may still speak plain SMTP.
 */
import nodemailer, { type SmtpTransportOptions } from 'nodemailer';

export interface SmtpSettings {
  /** `SMTP_URL` */
  readonly url: string;
  /** `SMTP_FROM`, like `Surface <surface@example.com>` */
  readonly from: string;
}

export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** What went wrong, without the SMTP password or the message. Safe to log. */
export interface SmtpFailure {
  readonly code?: string;
  readonly responseCode?: number;
  readonly command?: string;
  readonly message: string;
}

export type SendOutcome =
  | { readonly ok: true; readonly messageId: string }
  | {
      readonly ok: false;
      /** The server refused this message for good (5xx): retrying sends nothing. */
      readonly permanent: boolean;
      readonly failure: SmtpFailure;
    };

export interface Mailer {
  send(email: OutgoingEmail): Promise<SendOutcome>;
  close(): void;
}

export interface MailerTimeouts {
  /** Milliseconds to open the connection. */
  readonly connectionMs?: number;
  /** Milliseconds to wait for the server's greeting. */
  readonly greetingMs?: number;
  /** Milliseconds of silence before giving up on a connection. */
  readonly socketMs?: number;
}

export function smtpTransportOptions(
  settings: SmtpSettings,
  timeouts: MailerTimeouts = {},
): SmtpTransportOptions {
  const url = new URL(settings.url);
  const secure = url.protocol === 'smtps:';
  const user = decode(url.username);
  const pass = decode(url.password);
  return {
    // `new URL` keeps the brackets around an IPv6 address; sockets want it bare.
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: url.port === '' ? (secure ? 465 : 587) : Number(url.port),
    secure,
    requireTLS: !secure && user !== '',
    ...(user === '' ? {} : { auth: { user, pass } }),
    connectionTimeout: timeouts.connectionMs ?? 10_000,
    greetingTimeout: timeouts.greetingMs ?? 10_000,
    socketTimeout: timeouts.socketMs ?? 30_000,
    // Nodemailer's own logging would print the SMTP conversation, including AUTH.
    logger: false,
    debug: false,
    // Messages never load files or URLs (rule 5); ours carry none, keep it that way.
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

export function createMailer(settings: SmtpSettings, timeouts: MailerTimeouts = {}): Mailer {
  const transport = nodemailer.createTransport(smtpTransportOptions(settings, timeouts));
  const secrets = credentialsOf(settings.url);
  return {
    async send(email) {
      try {
        const info = await transport.sendMail({
          from: settings.from,
          to: email.to,
          subject: email.subject,
          text: email.text,
          html: email.html,
          // RFC 3834: tells auto-responders not to answer.
          headers: { 'Auto-Submitted': 'auto-generated' },
        });
        return { ok: true, messageId: info.messageId };
      } catch (error) {
        const failure = describeSmtpError(error, secrets);
        return { ok: false, permanent: isPermanentFailure(failure), failure };
      }
    },
    close() {
      transport.close();
    },
  };
}

/**
 * Whether the server refused this message for good: a 5xx reply (RFC 5321 §4.2.1) to a recipient
 * (`RCPT TO`) or to the message itself (`DATA`), so retrying sends nothing. Anything else is
 * retried: a refused sender (`MAIL FROM`, usually a wrong `SMTP_FROM` or a relay that wants a
 * login), login or TLS upgrade, which the operator can fix; connection trouble, timeouts and 4xx.
 */
export function isPermanentFailure(failure: SmtpFailure): boolean {
  const code = failure.responseCode;
  if (code === undefined || code < 500 || code >= 600) return false;
  return (
    (failure.code === 'EENVELOPE' && failure.command === 'RCPT') ||
    (failure.code === 'EMESSAGE' && failure.command === 'DATA')
  );
}

/** `failure` with each of `secrets` masked in its message. */
export function maskSecrets(failure: SmtpFailure, secrets: readonly string[]): SmtpFailure {
  return { ...failure, message: mask(failure.message, secrets) };
}

function mask(text: string, secrets: readonly string[]): string {
  // Longest first, so a link is masked whole before its token.
  const ordered = [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  let masked = text;
  for (const secret of ordered) masked = masked.split(secret).join('[redacted]');
  return masked;
}

/** The URL's user name and password, raw and decoded, to scrub from error messages. */
function credentialsOf(smtpUrl: string): string[] {
  const url = new URL(smtpUrl);
  return [url.username, url.password, decode(url.username), decode(url.password)].filter(
    (part) => part.length >= 3,
  );
}

/** Percent-decoding that keeps a malformed escape as written instead of throwing. */
function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * An SMTP error as fields that are safe to log (CLAUDE.md rule 6). Nodemailer's messages quote
 * the server's reply, and an odd server could echo what it was sent; the credentials are
 * masked in case it echoes them.
 */
export function describeSmtpError(error: unknown, secrets: readonly string[] = []): SmtpFailure {
  if (!(error instanceof Error)) return { message: 'Unknown SMTP error' };
  const message = mask(error.message, secrets);
  const code = 'code' in error ? error.code : undefined;
  const responseCode = 'responseCode' in error ? error.responseCode : undefined;
  // `AUTH PLAIN …` and the like: the verb is enough, the rest could be a credential.
  const command = 'command' in error ? error.command : undefined;
  return {
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof responseCode === 'number' ? { responseCode } : {}),
    ...(typeof command === 'string' ? { command: command.split(' ')[0] ?? '' } : {}),
    message,
  };
}
