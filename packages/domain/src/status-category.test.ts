import { describe, expect, it } from 'vitest';
import { CLOSED_CATEGORIES, isStatusCategory, STATUS_CATEGORIES } from './status-category.js';
import { priorityLabel } from './priority.js';

describe('status categories', () => {
  it('has the seven fixed categories', () => {
    expect(STATUS_CATEGORIES).toHaveLength(7);
  });

  it('recognises valid categories only', () => {
    expect(isStatusCategory('started')).toBe(true);
    expect(isStatusCategory('done')).toBe(false);
    expect(isStatusCategory(3)).toBe(false);
  });

  it('treats completed, canceled and duplicate as closed', () => {
    expect([...CLOSED_CATEGORIES].sort()).toEqual(['canceled', 'completed', 'duplicate']);
  });
});

describe('priority', () => {
  it('labels 0 as no priority and 1 as urgent', () => {
    expect(priorityLabel(0)).toBe('No priority');
    expect(priorityLabel(1)).toBe('Urgent');
  });
});
