// PLAN-012 S6 (SPEC-012 §3.7, AC-10): what each Copy action puts on the clipboard and says in its
// toast. Pure, so the list's row menu, the page's header and the keys share the wording.
import { describe, expect, it } from 'vitest';
import {
  COPY_ITEMS,
  planCopy,
  type CopyKind,
  type CopyTarget,
} from '../src/features/issues/copy-actions.js';

const origin = 'https://surface.example.com';
const target: CopyTarget = { identifier: 'ENG-42', title: 'Fix login redirect' };
const plan = (kind: CopyKind, over: Partial<CopyTarget> = {}) =>
  planCopy(kind, { ...target, ...over }, origin, 'ada');

describe('copy actions (§3.7)', () => {
  it('copies the exact text and says so', () => {
    expect(plan('id')).toEqual({ ok: true, text: 'ENG-42', message: 'Copied ENG-42' });
    expect(plan('url')).toEqual({
      ok: true,
      text: 'https://surface.example.com/issue/ENG-42/fix-login-redirect',
      message: 'Copied link to ENG-42',
    });
    expect(plan('title')).toEqual({
      ok: true,
      text: 'Fix login redirect',
      message: 'Copied title',
    });
    expect(plan('title-link')).toEqual({
      ok: true,
      text: '[Fix login redirect](https://surface.example.com/issue/ENG-42/fix-login-redirect)',
      message: 'Copied title as link',
    });
    expect(plan('branch')).toEqual({
      ok: true,
      text: 'ada/eng-42-fix-login-redirect',
      message: 'Copied branch name',
    });
  });

  it('copies the issue as Markdown: heading, description, URL', () => {
    const description = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'It loops.' }] }],
    };
    expect(plan('markdown', { description })).toEqual({
      ok: true,
      text: '# ENG-42 Fix login redirect\n\nIt loops.\n\nhttps://surface.example.com/issue/ENG-42/fix-login-redirect',
      message: 'Copied ENG-42 as Markdown',
    });
  });

  it('leaves the description part out when the caller has none', () => {
    const copied = plan('markdown');
    expect(copied.ok && copied.text).toBe(
      '# ENG-42 Fix login redirect\n\nhttps://surface.example.com/issue/ENG-42/fix-login-redirect',
    );
  });

  it('a title with no letters or digits gives a URL with no slug', () => {
    const copied = plan('url', { title: '!!!' });
    expect(copied.ok && copied.text).toBe('https://surface.example.com/issue/ENG-42');
  });

  it('a pending issue copies nothing and says to wait', () => {
    for (const { kind } of COPY_ITEMS) {
      expect(plan(kind, { identifier: null })).toEqual({
        ok: false,
        message: 'Wait a moment: ENG-… has no number yet.',
      });
    }
  });

  it('lists every action once, in the Copy › submenu order', () => {
    expect(COPY_ITEMS.map((item) => item.label)).toEqual([
      'Copy ID',
      'Copy URL',
      'Copy title',
      'Copy title as link',
      'Copy issue as Markdown',
      'Copy git branch name',
    ]);
  });
});
