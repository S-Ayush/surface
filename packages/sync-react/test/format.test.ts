import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration } from '../src/format.js';

describe('sizes and durations in the inspector', () => {
  it('shows bytes in the largest unit under 1024, with one decimal', () => {
    expect(
      [0, 512, 1024, 1536, 1024 ** 2 * 1.25, 1024 ** 3 * 3, 1024 ** 4].map(formatBytes),
    ).toEqual(['0 B', '512 B', '1.0 KB', '1.5 KB', '1.3 MB', '3.0 GB', '1024.0 GB']);
  });

  it('shows durations in ms, then whole seconds, minutes and hours; never negative', () => {
    expect(
      [-5, 0, 120.4, 999, 1000, 59_999, 60_000, 3_599_999, 3_600_000, 90_000_000].map(
        formatDuration,
      ),
    ).toEqual([
      '0 ms',
      '0 ms',
      '120 ms',
      '999 ms',
      '1 s',
      '59 s',
      '1 min',
      '59 min',
      '1 h',
      '25 h',
    ]);
  });
});
