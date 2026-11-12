import type { Meta, StoryObj } from '@storybook/react-vite';
import { useCallback, useRef } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import panel from '../../stories/panel.module.css';
import { sampleTitle } from '../../stories/issue-data.js';
import { GroupHeader } from '../GroupHeader/GroupHeader.js';
import { IssueRow } from '../IssueRow/IssueRow.js';
import { StatusIcon } from '../StatusIcon/StatusIcon.js';
import { VirtualList, type VirtualListHandle } from './VirtualList.js';
import { GROUP_HEADER_HEIGHT, ROW_HEIGHT } from './window.js';

const meta = { title: 'Primitives/VirtualList' } satisfies Meta;
export default meta;
type Story = StoryObj;

const GROUP_SIZE = 500;
const GROUPS = 20; // 20 headers + 10,000 issues

/** Item `i` is a header when it starts a block of GROUP_SIZE rows. */
const isHeader = (index: number) => index % (GROUP_SIZE + 1) === 0;
const itemHeight = (index: number) => (isHeader(index) ? GROUP_HEADER_HEIGHT : ROW_HEIGHT);

function Issues({ pinnedIndex = null }: { pinnedIndex?: number | null }) {
  const handle = useRef<VirtualListHandle>(null);
  const render = useCallback(
    ({
      index,
      style,
      tabIndex,
    }: {
      index: number;
      style: React.CSSProperties;
      tabIndex: 0 | -1;
    }) => {
      if (isHeader(index)) {
        const group = index / (GROUP_SIZE + 1) + 1;
        return (
          <GroupHeader
            key={index}
            name={`Group ${group}`}
            count={GROUP_SIZE}
            icon={<StatusIcon category="started" color="amber" />}
            collapsed={false}
            onToggle={() => {}}
            rowIndex={index + 1}
            tabIndex={tabIndex}
            style={style}
          />
        );
      }
      return (
        <IssueRow
          key={index}
          rowIndex={index + 1}
          level={2}
          identifier={`ENG-${index}`}
          title={sampleTitle(index)}
          priority={(index % 5) as 0 | 1 | 2 | 3 | 4}
          status={{ name: 'In Progress', category: 'started', color: 'amber' }}
          createdLabel="Nov 6"
          tabIndex={tabIndex}
          style={style}
        />
      );
    },
    [],
  );
  return (
    <div className={panel['listBox']}>
      <VirtualList
        ref={handle}
        aria-label="Issues"
        count={GROUPS * (GROUP_SIZE + 1)}
        itemHeight={itemHeight}
        isHeader={isHeader}
        pinnedIndex={pinnedIndex}
        renderItem={render}
      />
    </div>
  );
}

export const TenThousandIssues: Story = { render: () => <Issues /> };

/** At 10,000 issues only the window is in the DOM; `aria-rowcount` still says 10,020. */
export const Windowing: Story = {
  render: () => <Issues pinnedIndex={3} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grid = canvas.getByRole('treegrid', { name: 'Issues' });
    await expect(grid).toHaveAttribute('aria-rowcount', String(GROUPS * (GROUP_SIZE + 1)));
    await expect(canvas.getAllByRole('row').length).toBeLessThan(40);
    const scroller = grid.parentElement;
    if (!scroller) throw new Error('No scroll container');
    scroller.scrollTop = 40_000;
    await waitFor(() => expect(canvas.queryByRole('row', { name: /ENG-1\b/ })).toBeNull());
    await expect(canvas.getAllByRole('row').length).toBeLessThan(40);
    // The pinned (focused) row stays mounted far from the view, as the only tab stop.
    const pinned = canvas.getByRole('row', { name: /ENG-3\b/ });
    await expect(pinned).toHaveAttribute('aria-rowindex', '4');
    await expect(pinned).toHaveAttribute('tabindex', '0');
    // Every rendered row says where it sits in the whole list.
    for (const row of canvas.getAllByRole('row')) {
      await expect(Number(row.getAttribute('aria-rowindex'))).toBeGreaterThan(0);
    }
  },
};

/** The group header above the view sticks to the top while its rows scroll. */
export const StickyHeader: Story = {
  render: () => <Issues />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grid = canvas.getByRole('treegrid', { name: 'Issues' });
    const scroller = grid.parentElement;
    if (!scroller) throw new Error('No scroll container');
    scroller.scrollTop = 5 * ROW_HEIGHT;
    await waitFor(async () => {
      const header = canvas.getByRole('row', { name: /^Group 1,/ });
      const top = header.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      await expect(Math.abs(top)).toBeLessThan(1);
    });
  },
};

export const Keyboard: Story = {
  render: () => <Issues pinnedIndex={2} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('row', { name: /ENG-2\b/ })).toHaveFocus();
  },
};
