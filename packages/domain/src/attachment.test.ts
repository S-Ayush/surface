// PLAN-014 S4a, SPEC-014 §4.1, AC-7 (link half), E11, E12: the shared title and URL rules the
// client's optimistic code and the server's handlers both use.
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MESSAGES,
  attachmentTitle,
  attachmentTitleProblem,
  defaultLinkTitle,
  parseAttachmentUrl,
} from './attachment.js';

describe('parseAttachmentUrl (AC-7, E11, E12)', () => {
  it.each([
    [
      'https://www.figma.com/file/abc123/Login-flow',
      'https://www.figma.com/file/abc123/Login-flow',
    ],
    ['  http://example.com/a b  ', 'http://example.com/a%20b'],
    ['HTTPS://Example.COM', 'https://example.com/'],
  ])('accepts %s, stored as the URL parser writes it', (typed, stored) => {
    expect(parseAttachmentUrl(typed)).toEqual({ ok: true, url: stored });
  });

  it.each([
    'http://10.0.0.5/admin',
    'http://localhost:8080/',
    'http://192.168.1.1',
    'https://intranet/',
  ])('allows the private or internal address %s: it is never fetched (E12)', (url) => {
    expect(parseAttachmentUrl(url).ok).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://example.com/file',
    'mailto:ada@example.com',
    'example.com',
    '/relative/path',
    '',
  ])('refuses %s: not an absolute http(s) address (E11)', (url) => {
    expect(parseAttachmentUrl(url)).toEqual({ ok: false, problem: ATTACHMENT_MESSAGES.badScheme });
  });

  it.each([
    'https://ada:secret@example.com/',
    'https://ada@example.com/',
    'http://:pw@example.com',
  ])('refuses %s: credentials in the address (E11)', (url) => {
    expect(parseAttachmentUrl(url)).toEqual({
      ok: false,
      problem: ATTACHMENT_MESSAGES.credentials,
    });
  });

  it('keeps an @ in the path or query, which is not a credential', () => {
    expect(parseAttachmentUrl('https://example.com/@ada?by=a@b')).toEqual({
      ok: true,
      url: 'https://example.com/@ada?by=a@b',
    });
  });

  it('allows 2,048 characters and refuses more, as typed and as stored', () => {
    const base = 'https://example.com/';
    const at = (n: number) => base + 'a'.repeat(n - base.length);
    expect(parseAttachmentUrl(at(2048)).ok).toBe(true);
    expect(parseAttachmentUrl(at(2049))).toEqual({
      ok: false,
      problem: ATTACHMENT_MESSAGES.urlTooLong,
    });
    // Percent-encoding lengthens the stored form past the limit.
    const spaced = `${base}${' '.repeat(700)}x`;
    expect(parseAttachmentUrl(spaced)).toEqual({
      ok: false,
      problem: ATTACHMENT_MESSAGES.urlTooLong,
    });
  });
});

describe('attachment titles (§4.1)', () => {
  it('defaults a link’s title to the address without its scheme', () => {
    expect(defaultLinkTitle('https://www.figma.com/file/abc123')).toBe('www.figma.com/file/abc123');
    expect(defaultLinkTitle('http://10.0.0.5/')).toBe('10.0.0.5/');
  });

  it('cuts a long default to 255 characters without splitting a character', () => {
    const url = `https://example.com/${'😀'.repeat(300)}`;
    const title = defaultLinkTitle(url);
    expect([...title]).toHaveLength(255);
    expect(title.endsWith('😀')).toBe(true);
  });

  it('keeps a typed title, normalised, and falls back to the default when blank', () => {
    expect(attachmentTitle('  Login\nflow ', 'x.png')).toBe('Login flow');
    expect(attachmentTitle('   ', 'x.png')).toBe('x.png');
    expect(attachmentTitle(undefined, 'x.png')).toBe('x.png');
  });

  it('refuses a blank or over-long typed title', () => {
    expect(attachmentTitleProblem('  ')).toBe(ATTACHMENT_MESSAGES.titleRequired);
    expect(attachmentTitleProblem('a'.repeat(256))).toBe(ATTACHMENT_MESSAGES.titleTooLong);
    expect(attachmentTitleProblem('a'.repeat(255))).toBeUndefined();
    expect(attachmentTitleProblem('😀'.repeat(255))).toBeUndefined();
  });

  it('words the §6.4 messages', () => {
    expect(ATTACHMENT_MESSAGES).toMatchObject({
      limit: 'An issue can have at most 100 attachments. Remove one first.',
      badScheme: 'Use a web address that starts with https:// or http://.',
      credentials: "Web addresses can't include a user name or password.",
      fileNotFound: "That upload has expired or isn't yours. Upload the file again.",
    });
  });
});
