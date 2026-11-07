import { describe, expect, it } from 'vitest';
import { NAME_MAX_LENGTH, nameProblem } from './names.js';

describe('nameProblem', () => {
  it('requires a name that is more than spaces', () => {
    expect(nameProblem('Team name', '   ', 64)).toBe('Team name is required');
    expect(nameProblem('Team name', ' Engineering ', 64)).toBeUndefined();
  });

  it('refuses a name longer than the limit, saying the limit', () => {
    const max = NAME_MAX_LENGTH.workspace;
    expect(nameProblem('Workspace name', 'a'.repeat(max), max)).toBeUndefined();
    expect(nameProblem('Workspace name', 'a'.repeat(max + 1), max)).toBe(
      'Workspace name must be at most 64 characters long',
    );
  });

  it('counts characters as the user sees them', () => {
    expect(nameProblem('Your name', '🦊'.repeat(80), 80)).toBeUndefined();
    expect(nameProblem('Your name', '🦊'.repeat(81), 80)).toBeDefined();
  });
});
