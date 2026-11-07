// The label palette must offer exactly the colours the domain accepts for teams, labels and
// projects (session E handoff, PLAN-001 S1): a hue missing on either side would be unpickable or
// unrenderable.
import { COLOR_HUES } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import { LABEL_HUES } from '../tokens/primitives.js';

describe('label hues', () => {
  it('match the domain colour hues, in order', () => {
    expect([...LABEL_HUES]).toEqual([...COLOR_HUES]);
  });
});
