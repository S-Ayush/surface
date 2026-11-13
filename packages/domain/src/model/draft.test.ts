// PLAN-012 S5 (SPEC-012 §4.3): the `Draft` model and its `data` shapes. Reading a stored draft
// keeps every field it can, so a draft from another version or a damaged one isn't lost whole.
import { describe, expect, it } from 'vitest';
import {
  CommentDraftData,
  ComposerDraftData,
  Draft,
  EMPTY_COMPOSER_DRAFT,
  docFirstLine,
  readCommentDraft,
  readComposerDraft,
} from './draft.js';
import { PRODUCTION_MODELS } from './workspace-models.js';

const ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const doc = (...paragraphs: string[]) => ({
  type: 'doc',
  content: paragraphs.map((text) =>
    text === '' ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text }] },
  ),
});

describe('the Draft model', () => {
  it('is a production model, so client and server hash it alike', () => {
    expect(PRODUCTION_MODELS).toContain(Draft);
  });

  it('declares no groups and no refs: it is user-scoped and resolves nothing (permissions.md §2)', () => {
    expect(Object.keys(Draft.fields)).not.toContain('groups');
    expect(Draft.refs).toEqual({});
  });
});

describe('ComposerDraftData', () => {
  it('accepts the empty draft and a full one', () => {
    expect(ComposerDraftData.safeParse(EMPTY_COMPOSER_DRAFT).success).toBe(true);
    const full = {
      title: 'Fix the login loop',
      description: doc('Steps'),
      statusId: ID,
      priority: 1,
      assigneeId: ID,
      labelIds: [ID],
      estimate: 3,
      dueDate: '2026-11-30',
    };
    expect(ComposerDraftData.parse(full)).toEqual(full);
  });

  it('refuses unknown fields, more than 20 labels and a priority outside 0–4', () => {
    expect(ComposerDraftData.safeParse({ ...EMPTY_COMPOSER_DRAFT, extra: 1 }).success).toBe(false);
    expect(
      ComposerDraftData.safeParse({ ...EMPTY_COMPOSER_DRAFT, labelIds: Array(21).fill(ID) })
        .success,
    ).toBe(false);
    expect(ComposerDraftData.safeParse({ ...EMPTY_COMPOSER_DRAFT, priority: 5 }).success).toBe(
      false,
    );
  });

  it('bounds the description at 200 KB of JSON and the comment at 50 KB', () => {
    const sized = (bytes: number) => doc('x'.repeat(bytes));
    expect(
      ComposerDraftData.safeParse({ ...EMPTY_COMPOSER_DRAFT, description: sized(204_700) }).success,
    ).toBe(true);
    expect(
      ComposerDraftData.safeParse({ ...EMPTY_COMPOSER_DRAFT, description: sized(204_800) }).success,
    ).toBe(false);
    expect(CommentDraftData.safeParse({ text: sized(51_100) }).success).toBe(true);
    expect(CommentDraftData.safeParse({ text: sized(51_200) }).success).toBe(false);
  });
});

describe('readComposerDraft', () => {
  it('keeps each valid field and empties the others', () => {
    expect(
      readComposerDraft({ title: 'Kept', priority: 9, labelIds: 'x', dueDate: '2026-12-01' }),
    ).toEqual({ ...EMPTY_COMPOSER_DRAFT, title: 'Kept', dueDate: '2026-12-01' });
  });

  it('reads anything but an object as the empty draft', () => {
    for (const data of [null, undefined, 'x', 3, []]) {
      expect(readComposerDraft(data)).toEqual(EMPTY_COMPOSER_DRAFT);
    }
  });
});

describe('readCommentDraft and docFirstLine', () => {
  it('reads the comment’s document, or nothing', () => {
    expect(readCommentDraft({ text: doc('Hi') })).toEqual(doc('Hi'));
    expect(readCommentDraft({ text: 'plain' })).toBeUndefined();
    expect(readCommentDraft(null)).toBeUndefined();
  });

  it('gives the first block with text, on one line', () => {
    expect(docFirstLine(doc('', 'First  line', 'Second'))).toBe('First line');
    expect(docFirstLine(doc(''))).toBe('');
    expect(docFirstLine(undefined)).toBe('');
    expect(
      docFirstLine({
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [{ type: 'listItem', content: [doc('One').content[0] ?? { type: 'x' }] }],
          },
        ],
      }),
    ).toBe('One');
  });
});
