// Stories for the editor and DocView (PLAN-013 S2). Storybook runs from packages/ui and lists
// these through its `stories` glob, so the axe check (AC-17, axe half) covers them in both
// themes. Plain CSF: this package doesn't depend on Storybook.
import type { DocNodeJSON } from '@surface/domain';
import { useState } from 'react';
import { DocView, RichTextEditor } from '../src/index.js';

const text = (value: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) => ({
  type: 'text',
  text: value,
  ...(marks === undefined ? {} : { marks }),
});

const SAMPLE: DocNodeJSON = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [text('Rollout plan')] },
    {
      type: 'paragraph',
      content: [
        text('Ship behind a flag, then read the '),
        text('runbook', [{ type: 'link', attrs: { href: 'https://example.com/runbook' } }]),
        text(' before '),
        text('turning it on', [{ type: 'bold' }]),
        text('. Use '),
        text('flag.enable()', [{ type: 'code' }]),
        text('.'),
      ],
    },
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: true },
          content: [{ type: 'paragraph', content: [text('Write the migration')] }],
        },
        {
          type: 'taskItem',
          attrs: { checked: false },
          content: [{ type: 'paragraph', content: [text('Review with the team')] }],
        },
      ],
    },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [text('Measure twice.')] }] },
    {
      type: 'codeBlock',
      attrs: { language: 'typescript' },
      content: [text('export const enabled = (flag: string): boolean => flag === "on";')],
    },
  ],
};

const EMPTY: DocNodeJSON = { type: 'doc', content: [{ type: 'paragraph' }] };

function Editable({ mode, initial }: { mode: 'comment' | 'description'; initial: DocNodeJSON }) {
  const [value, setValue] = useState(initial);
  return (
    <RichTextEditor
      mode={mode}
      value={value}
      onChange={setValue}
      placeholder={mode === 'comment' ? 'Leave a comment…' : 'Add description…'}
    />
  );
}

export default { title: 'Editor/RichTextEditor' };

export const Description = { render: () => <Editable mode="description" initial={SAMPLE} /> };
export const CommentEmpty = { render: () => <Editable mode="comment" initial={EMPTY} /> };
export const ReadOnly = {
  render: () => <RichTextEditor mode="description" value={SAMPLE} readOnly checklistEditable />,
};

export const DocViewDefault = {
  name: 'DocView',
  render: () => <DocView doc={SAMPLE} onToggle={() => undefined} />,
};

export const DocViewMissingImage = {
  name: 'DocView, missing image',
  render: () => (
    <DocView
      doc={{
        type: 'doc',
        content: [
          {
            type: 'image',
            attrs: { src: '/files/0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7b', alt: 'shot' },
          },
        ],
      }}
      missingFileIds={new Set(['0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7b'])}
    />
  ),
};
