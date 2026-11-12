// S9 security review L1: an operation whose output holds a link shown once (`secretOutput`) never
// has it stored for an idempotent replay (SPEC-001 §6.2: only the link's hash is stored), and a
// repeated `clientMutationId` is refused. The SQL around these runs in the existing idempotency
// integration test; new integration tests are held (plans README §6).
import { inviteCreate, userCreateResetLink, userSetRole } from '@surface/operations';
import { mutationOkSchema } from '@surface/sync-protocol';
import { describe, expect, it } from 'vitest';
import { checkReplayable, storedOutput } from '../src/executor/idempotency.js';

const OUTPUT = { url: 'https://s.example.com/invite/a-live-token', emailed: false };

describe('idempotency for outputs with a secret (S9 security review L1)', () => {
  it('flags the operations that return a link shown once', () => {
    expect(inviteCreate.secretOutput).toBeDefined();
    expect(userCreateResetLink.secretOutput).toBeDefined();
    expect(userSetRole.secretOutput).toBeUndefined();
  });

  it('stores nothing of their output, and an ordinary output whole', () => {
    expect(storedOutput(inviteCreate, OUTPUT)).toBeNull();
    expect(storedOutput(userCreateResetLink, OUTPUT)).toBeNull();
    expect(storedOutput(userSetRole, OUTPUT)).toBe(OUTPUT);
  });

  it('has nothing to keep out of sync replays: a synced result carries no output', () => {
    // `client_mutations` stores each (clientId, seq) result for replays (SPEC-002 §4.4). It holds
    // no output, so a link sent through /sync/mutate is never stored there either.
    expect(Object.keys(mutationOkSchema.shape)).toEqual(['seq', 'status', 'lastSyncId']);
  });

  it('refuses their replay with what to do instead, and replays others', () => {
    expect(() => checkReplayable(inviteCreate)).toThrow(
      expect.objectContaining({
        code: 'CONFLICT',
        message:
          'This invite was already created, and its link is shown only once. Revoke it in Members and invite again.',
      }),
    );
    expect(() => checkReplayable(userCreateResetLink)).toThrow(
      expect.objectContaining({ code: 'CONFLICT' }),
    );
    expect(() => checkReplayable(userSetRole)).not.toThrow();
  });
});
