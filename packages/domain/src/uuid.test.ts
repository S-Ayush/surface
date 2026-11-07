// Client-generated UUIDv7 ids (SPEC-003 §8, E7): what create ops such as `team.create` accept.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { uuidv7 } from './uuid.js';

const V7 = z.uuid({ version: 'v7' });

describe('uuidv7', () => {
  it('is a UUIDv7 that sorts by the time it was made', () => {
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_700_000_000_001);
    expect(V7.safeParse(early).success).toBe(true);
    expect(V7.safeParse(uuidv7()).success).toBe(true);
    expect(early < late).toBe(true);
    expect(early.slice(0, 13).replace('-', '')).toBe(
      (1_700_000_000_000).toString(16).padStart(12, '0'),
    );
  });

  it('sets the version and variant bits whatever the random bytes', () => {
    expect(uuidv7(0, new Uint8Array(10).fill(0xff))).toBe('00000000-0000-7fff-bfff-ffffffffffff');
    expect(uuidv7(0, new Uint8Array(10))).toBe('00000000-0000-7000-8000-000000000000');
  });
});
