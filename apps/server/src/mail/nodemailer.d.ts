/**
 * The part of Nodemailer 10 that `smtp.ts` uses. Declared here instead of installing
 * `@types/nodemailer`, which depends on the AWS SES SDK (about 25 packages) only to type a
 * transport Surface never uses. Keep it to what we call; the shapes follow Nodemailer's
 * SMTP transport docs (https://nodemailer.com/smtp/).
 */
declare module 'nodemailer' {
  export interface SmtpTransportOptions {
    host: string;
    port: number;
    /** TLS from the first byte (port 465). */
    secure: boolean;
    /** Fail unless the server upgrades with STARTTLS. */
    requireTLS: boolean;
    auth?: { user: string; pass: string };
    connectionTimeout: number;
    greetingTimeout: number;
    socketTimeout: number;
    logger: boolean;
    debug: boolean;
    disableFileAccess: boolean;
    disableUrlAccess: boolean;
  }

  export interface MailMessage {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    headers?: Record<string, string>;
  }

  export interface SentMessageInfo {
    messageId: string;
  }

  export interface Transporter {
    sendMail(message: MailMessage): Promise<SentMessageInfo>;
    close(): void;
  }

  export function createTransport(options: SmtpTransportOptions): Transporter;

  const nodemailer: { createTransport: typeof createTransport };
  export default nodemailer;
}
