import { describe, expect, it } from 'vitest';
import { inspectorAllowed } from '../src/gate.js';

describe('who sees the sync inspector (SPEC-002 §5.4)', () => {
  it('shows it in every development build', () => {
    expect(inspectorAllowed({ dev: true, search: '', role: undefined })).toBe(true);
  });

  it('shows it in production only to an Admin who asks with ?debug=sync', () => {
    expect(inspectorAllowed({ dev: false, search: '?debug=sync', role: 'admin' })).toBe(true);
    expect(inspectorAllowed({ dev: false, search: '?debug=perf&debug=sync', role: 'admin' })).toBe(
      true,
    );
    expect(inspectorAllowed({ dev: false, search: '?debug=sync', role: 'member' })).toBe(false);
    expect(inspectorAllowed({ dev: false, search: '', role: 'admin' })).toBe(false);
    expect(inspectorAllowed({ dev: false, search: '?debug=synchronous', role: 'admin' })).toBe(
      false,
    );
  });

  it('stays closed in production while the role is unknown (until PLAN-001 S7)', () => {
    expect(inspectorAllowed({ dev: false, search: '?debug=sync', role: undefined })).toBe(false);
  });
});
