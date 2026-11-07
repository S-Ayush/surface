/**
 * The emails Surface sends (PLAN-001 S4): a magic link, a password reset and an invite
 * (SPEC-001 §3.2–3.4). Each has an HTML body and a plain-text alternative.
 *
 * The HTML is plain on purpose: inline styles only, no images, fonts or anything else loaded
 * from elsewhere (CLAUDE.md rule 5; mail clients block remote content anyway). Every value is
 * escaped, because names come from users.
 */

import { LINK_LIFETIME_TEXT } from '@surface/domain';

/** How long each link works; the web pages say the same (`@surface/domain`). */
export { LINK_LIFETIME_TEXT };

export interface MagicLinkEmail {
  readonly template: 'magicLink';
  readonly workspaceName: string;
  readonly link: string;
}

export interface PasswordResetEmail {
  readonly template: 'passwordReset';
  readonly workspaceName: string;
  readonly link: string;
}

export interface InviteEmail {
  readonly template: 'invite';
  readonly workspaceName: string;
  readonly inviterName: string;
  readonly link: string;
}

export type EmailContent = MagicLinkEmail | PasswordResetEmail | InviteEmail;

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

interface Layout {
  readonly subject: string;
  /** Paragraphs before the button. */
  readonly lead: readonly string[];
  readonly action: string;
  readonly link: string;
  /** Paragraphs after the button. */
  readonly after: readonly string[];
}

export function renderEmail(email: EmailContent): RenderedEmail {
  return render(layout(email));
}

function layout(email: EmailContent): Layout {
  const workspace = email.workspaceName;
  switch (email.template) {
    case 'magicLink':
      return {
        subject: `Your login link for ${workspace}`,
        lead: [`Use this link to log in to ${workspace} on Surface.`],
        action: 'Log in',
        link: email.link,
        after: [
          `The link works once, for ${LINK_LIFETIME_TEXT.magicLink}. Asking for a new one turns this one off.`,
          'If you did not ask for it, ignore this email: nobody can log in without the link.',
        ],
      };
    case 'passwordReset':
      return {
        subject: `Reset your password for ${workspace}`,
        lead: [`Use this link to choose a new password for ${workspace} on Surface.`],
        action: 'Choose a new password',
        link: email.link,
        after: [
          `The link works once, for ${LINK_LIFETIME_TEXT.passwordReset}. Setting a new password logs you out everywhere else.`,
          'If you did not ask for it, ignore this email: your password stays the same.',
        ],
      };
    case 'invite':
      return {
        subject: `${email.inviterName} invited you to ${workspace}`,
        lead: [`${email.inviterName} invited you to join ${workspace} on Surface.`],
        action: 'Accept the invite',
        link: email.link,
        after: [`The invite works for ${LINK_LIFETIME_TEXT.invite}.`],
      };
  }
}

function render({ subject: rawSubject, lead, action, link, after }: Layout): RenderedEmail {
  // Names come from users: keep a line break in one from reaching the Subject header.
  const subject = rawSubject.replace(/\s+/g, ' ').trim();
  const text = [...lead, `${action}: ${link}`, ...after].join('\n\n') + '\n';

  const paragraph = (body: string) =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:22px;color:#1f2328">${body}</p>`;
  const button =
    `<p style="margin:0 0 16px"><a href="${escapeHtml(link)}" ` +
    'style="display:inline-block;padding:10px 16px;border-radius:6px;background:#5e6ad2;' +
    `color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">${escapeHtml(action)}</a></p>`;
  // The bare link too, for clients that strip buttons and for copying.
  const fallback = paragraph(
    `Or open this link: <a href="${escapeHtml(link)}" style="color:#5e6ad2;word-break:break-all">${escapeHtml(link)}</a>`,
  );
  const html = [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(subject)}</title></head>`,
    '<body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif">',
    '<div style="max-width:480px;margin:0 auto">',
    ...lead.map((line) => paragraph(escapeHtml(line))),
    button,
    fallback,
    ...after.map((line) => paragraph(escapeHtml(line))),
    '</div></body></html>',
    '',
  ].join('\n');

  return { subject, text, html };
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}
