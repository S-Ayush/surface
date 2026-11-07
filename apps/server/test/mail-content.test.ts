// PLAN-001 S4: the emails' content (SPEC-001 §3.2–3.4; the unit part of AC-4, which is a held
// e2e). Each email has an HTML body and a text alternative with the link, escapes what users
// typed, and loads nothing from elsewhere (CLAUDE.md rule 5).
import { describe, expect, it } from 'vitest';
import { inviteUrl, magicLinkUrl, passwordResetUrl } from '../src/mail/links.js';
import { escapeHtml, renderEmail, type EmailContent } from '../src/mail/templates.js';

const LINK = 'https://surface.example.com/auth/magic?token=abc_DEF-123';

const emails: EmailContent[] = [
  { template: 'magicLink', workspaceName: 'Acme', link: LINK },
  { template: 'passwordReset', workspaceName: 'Acme', link: LINK },
  { template: 'invite', workspaceName: 'Acme', inviterName: 'Ada Lovelace', link: LINK },
];

describe('renderEmail', () => {
  it.each(emails)('puts the $template link in the text and the HTML', (email) => {
    const { subject, text, html } = renderEmail(email);
    expect(subject).toContain('Acme');
    expect(text).toContain(LINK);
    expect(html).toContain(`href="${LINK}"`);
    // The bare link too, for clients that strip the button.
    expect(html).toContain(`>${LINK}</a>`);
  });

  it('says how long each link works', () => {
    const [magic, reset, invite] = emails.map((email) => renderEmail(email).text);
    expect(magic).toContain('15 minutes');
    expect(reset).toContain('1 hour');
    expect(reset).toContain('logs you out everywhere else');
    expect(invite).toContain('7 days');
    expect(invite).toContain('Ada Lovelace invited you to join Acme');
  });

  it.each(emails)('loads nothing from elsewhere ($template)', (email) => {
    const { html } = renderEmail(email);
    expect(html).not.toMatch(/\ssrc=|url\(|@import|<link\b|<script\b|<img\b/i);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(new Set(hrefs)).toEqual(new Set([LINK]));
  });

  it('escapes names in the HTML and keeps them as typed in the text', () => {
    const { text, html } = renderEmail({
      template: 'invite',
      workspaceName: '<b>Acme</b> & "Co"',
      inviterName: '<script>alert(1)</script>',
      link: 'https://surface.example.com/invite/a"b',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Acme');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;Acme&lt;/b&gt; &amp; &quot;Co&quot;');
    expect(html).toContain('href="https://surface.example.com/invite/a&quot;b"');
    expect(text).toContain('<script>alert(1)</script> invited you to join <b>Acme</b> & "Co"');
  });

  it('keeps a line break in a name out of the subject', () => {
    const { subject } = renderEmail({
      template: 'invite',
      workspaceName: 'Acme\r\nBcc: victim@example.com',
      inviterName: 'Ada\n',
      link: LINK,
    });
    expect(subject).toBe('Ada invited you to Acme Bcc: victim@example.com');
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'x`)).toBe('&amp;&lt;&gt;&quot;&#39;x');
  });
});

describe('links (SPEC-001 §3.2–3.4)', () => {
  const origin = 'https://surface.example.com';

  it('builds the magic-link, reset and invite URLs on SURFACE_URL', () => {
    expect(magicLinkUrl(origin, 'tok')).toBe(`${origin}/auth/magic?token=tok`);
    expect(passwordResetUrl(origin, 'tok')).toBe(`${origin}/reset?token=tok`);
    expect(inviteUrl(origin, 'tok')).toBe(`${origin}/invite/tok`);
  });

  it('encodes the token', () => {
    expect(magicLinkUrl(origin, 'a+b/c=')).toBe(`${origin}/auth/magic?token=a%2Bb%2Fc%3D`);
    expect(inviteUrl(origin, 'a/b?c')).toBe(`${origin}/invite/a%2Fb%3Fc`);
  });

  it('accepts an origin with a trailing slash or a port', () => {
    expect(passwordResetUrl('http://localhost:3000/', 't')).toBe(
      'http://localhost:3000/reset?token=t',
    );
  });
});
