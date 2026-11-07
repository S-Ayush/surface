/**
 * A fake SMTP server on 127.0.0.1 for unit tests (CLAUDE.md "Testing": no third-party service).
 * It speaks just enough ESMTP for Nodemailer: EHLO, optional AUTH PLAIN, MAIL, RCPT, DATA,
 * RSET, NOOP, QUIT. No STARTTLS: it never advertises it. Replies can be scripted per command
 * to act out a refusing or failing server.
 */
import { createServer, type Socket } from 'node:net';

export interface ReceivedMail {
  readonly from: string;
  readonly to: readonly string[];
  /** The message as sent (headers and body), with dot-stuffing undone. */
  readonly raw: string;
  /** `raw` with quoted-printable soft breaks and escapes decoded, for searching. */
  readonly decoded: string;
}

export interface FakeSmtpOptions {
  /** Advertise AUTH PLAIN and accept exactly these credentials. */
  readonly auth?: { readonly user: string; readonly pass: string };
  /** Reply to MAIL FROM instead of `250`, like `553 5.7.1 Sender address rejected`. */
  readonly mailReply?: string;
  /** Reply to RCPT TO instead of `250`, like `450 4.2.1 Mailbox busy`. */
  readonly rcptReply?: string;
  /** Reply after the message data instead of `250`, like `550 5.7.1 Rejected`. */
  readonly dataReply?: string;
}

export interface FakeSmtp {
  readonly port: number;
  /** Every message accepted so far. */
  readonly messages: readonly ReceivedMail[];
  /** The verb of every command received (`EHLO`, `AUTH`, …), never its arguments. */
  readonly commands: readonly string[];
  /** Resolves with the next accepted message (or one already waiting). */
  nextMessage(): Promise<ReceivedMail>;
  close(): Promise<void>;
}

export async function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const messages: ReceivedMail[] = [];
  const commands: string[] = [];
  const waiting: ((mail: ReceivedMail) => void)[] = [];
  let delivered = 0;
  const sockets = new Set<Socket>();

  const accept = (mail: ReceivedMail) => {
    messages.push(mail);
    const resolve = waiting.shift();
    if (resolve !== undefined) {
      delivered++;
      resolve(mail);
    }
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    const reply = (line: string) => socket.write(`${line}\r\n`);

    let buffer = '';
    let from = '';
    let to: string[] = [];
    let data: string[] | undefined;
    let authenticated = options.auth === undefined;
    let awaitingAuth = false;

    const checkAuth = (base64: string) => {
      const [, user, pass] = Buffer.from(base64, 'base64').toString('utf8').split('\0');
      authenticated = user === options.auth?.user && pass === options.auth?.pass;
      reply(authenticated ? '235 2.7.0 Authenticated' : '535 5.7.8 Authentication failed');
    };

    const handle = (line: string) => {
      if (data !== undefined) {
        if (line !== '.') {
          data.push(line.startsWith('..') ? line.slice(1) : line);
          return;
        }
        const raw = data.join('\r\n');
        data = undefined;
        const answer = options.dataReply ?? '250 2.0.0 Ok: queued';
        if (answer.startsWith('250'))
          accept({ from, to, raw, decoded: decodeQuotedPrintable(raw) });
        reply(answer);
        return;
      }
      if (awaitingAuth) {
        awaitingAuth = false;
        checkAuth(line);
        return;
      }
      const verb = line.split(' ')[0]?.toUpperCase() ?? '';
      commands.push(verb);
      switch (verb) {
        case 'EHLO':
          reply('250-fake-smtp');
          if (options.auth !== undefined) reply('250-AUTH PLAIN');
          reply('250 8BITMIME');
          return;
        case 'HELO':
          reply('250 fake-smtp');
          return;
        case 'AUTH': {
          const [, mechanism, initial] = line.split(' ');
          if (options.auth === undefined || mechanism?.toUpperCase() !== 'PLAIN') {
            reply('504 5.5.4 Unrecognized authentication type');
          } else if (initial === undefined) {
            awaitingAuth = true;
            reply('334 ');
          } else {
            checkAuth(initial);
          }
          return;
        }
        case 'MAIL':
          if (!authenticated) {
            reply('530 5.7.0 Authentication required');
            return;
          }
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          to = [];
          reply(options.mailReply ?? '250 2.1.0 Ok');
          return;
        case 'RCPT': {
          const answer = options.rcptReply ?? '250 2.1.5 Ok';
          if (answer.startsWith('250')) to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          reply(answer);
          return;
        }
        case 'DATA':
          data = [];
          reply('354 End data with <CR><LF>.<CR><LF>');
          return;
        case 'RSET':
          from = '';
          to = [];
          reply('250 2.0.0 Ok');
          return;
        case 'NOOP':
          reply('250 2.0.0 Ok');
          return;
        case 'QUIT':
          reply('221 2.0.0 Bye');
          socket.end();
          return;
        default:
          reply('502 5.5.2 Command not recognized');
      }
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        handle(line);
      }
    });
    reply('220 fake-smtp ESMTP');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP port assigned');

  return {
    port: address.port,
    messages,
    commands,
    nextMessage: () => {
      const ready = messages[delivered];
      if (ready !== undefined) {
        delivered++;
        return Promise.resolve(ready);
      }
      return new Promise((resolve) => waiting.push(resolve));
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Undoes quoted-printable (RFC 2045 §6.7) on a whole message; good enough to search it. */
export function decodeQuotedPrintable(raw: string): string {
  const joined = raw.replace(/=\r\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const hex = joined.slice(i + 1, i + 3);
    if (joined[i] === '=' && /^[0-9A-F]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(joined.charAt(i), 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}
