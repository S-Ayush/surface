// PLAN-016 visual pass: a comment without reactions reserves no row under its body; the add-reaction
// button moves into the hover actions (still a real button, so keyboard reachable).
import { TooltipProvider } from '@surface/ui';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CommentCard } from '../src/features/comments/CommentCard.js';

const noop = () => undefined;
const props = {
  id: 'c1',
  authorName: 'Iris',
  createdAt: '2026-11-16T09:00:00.000Z',
  now: new Date('2026-11-16T12:00:00.000Z'),
  body: { type: 'doc', content: [{ type: 'paragraph' }] },
  loadEmoji: () => Promise.resolve([]),
  onReact: noop,
  onReply: noop,
  via: null,
  editedAt: null,
} as const;

describe('comment card reactions row', () => {
  it('renders no reactions row when there are no reactions, and keeps Add reaction in the header actions', () => {
    const html = renderToString(
      <TooltipProvider>
        <CommentCard {...props} chips={[]} />
      </TooltipProvider>,
    );
    expect(html).not.toMatch(/class="[^"]*reactions/);
    expect(html).toContain('Add reaction');
    expect(html.indexOf('Add reaction')).toBeLessThan(html.indexOf('Reply'));
  });

  it('renders the row under the body when there are reactions', () => {
    const chips = [{ emoji: '👍', count: 1, mine: false, label: 'thumbs up', people: ['Iris'] }];
    const html = renderToString(
      <TooltipProvider>
        <CommentCard {...props} chips={chips} />
      </TooltipProvider>,
    );
    expect(html).toMatch(/class="[^"]*reactions/);
  });
});
