// PLAN-015 S4 (SPEC-015 E1, E2): a description save refused because the issue was deleted or
// archived meanwhile offers **Copy text**, so the typing isn't lost; other refusals don't.
import type { DocNodeJSON } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import { refusedDescription, refusedTextToast } from '../src/features/issues/locked-refusal.js';

const DOC: DocNodeJSON = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Half a thought' }] }],
};

function deps() {
  const copied: string[] = [];
  return {
    copied,
    deps: {
      markdownOf: (doc: DocNodeJSON) => JSON.stringify(doc.content?.[0]?.content?.[0]?.text),
      copy: (text: string) => {
        copied.push(text);
        return Promise.resolve(true);
      },
    },
  };
}

describe('refusedTextToast', () => {
  it.each([
    'ENG-42 was deleted. Restore it to edit it.',
    'ENG-42 is archived. Restore it to edit it.',
  ])('offers Copy text for "%s" (E1)', (message) => {
    const { copied, deps: d } = deps();
    const options = refusedTextToast(message, DOC, d);
    expect(options.tone).toBe('danger');
    expect(options.message).toBe(message);
    expect(options.action?.label).toBe('Copy text');
    options.action?.onAction();
    expect(copied).toEqual(['"Half a thought"']);
  });

  it('offers nothing for another refusal, or without the text', () => {
    const { deps: d } = deps();
    expect(refusedTextToast('Title is too long.', DOC, d).action).toBeUndefined();
    expect(
      refusedTextToast('ENG-42 was deleted. Restore it to edit it.', undefined, d).action,
    ).toBeUndefined();
  });
});

describe('refusedDescription', () => {
  it('reads the text of a queued issue.updateDescription, and only that', () => {
    expect(
      refusedDescription('issue.updateDescription', {
        issue: 'i1',
        baseVersion: 3,
        description: DOC,
      }),
    ).toEqual(DOC);
    expect(refusedDescription('issue.update', { issue: 'i1', description: DOC })).toBeUndefined();
    expect(refusedDescription('issue.updateDescription', { issue: 'i1' })).toBeUndefined();
  });
});
