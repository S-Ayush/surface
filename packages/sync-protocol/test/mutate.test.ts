import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CSRF_INVALID,
  decodeMutateErrorBody,
  decodeMutateRequest,
  decodeMutateResponse,
  MAX_MUTATIONS_PER_BATCH,
  ProtocolError,
} from '../src/index.js';
import { mutateRequest, mutateResponse, propertyOptions, viaJson } from './support/arbitraries.js';

const ID = '0192f5a4-1c2b-7d3e-8f40-123456789abc';
const HASH = 'c'.repeat(64);
const call = (seq: number, extra: object = {}) => ({
  seq,
  op: 'debug.touch',
  input: { id: ID },
  ...extra,
});
const request = (mutations: unknown[]) => ({ clientId: ID, schemaHash: HASH, mutations });

describe('mutate request', () => {
  it('round-trips through JSON unchanged', () => {
    fc.assert(
      fc.property(mutateRequest, (req) => {
        expect(decodeMutateRequest(viaJson(req))).toEqual(viaJson(req));
      }),
      propertyOptions,
    );
  });

  it('accepts the sync-protocol.md §4.4 example', () => {
    const decoded = decodeMutateRequest(
      request([
        call(57, {
          op: 'issue.update',
          input: { id: ID, priority: 1 },
          at: '2026-11-06T10:00:00Z',
        }),
        call(58, { op: 'comment.create', input: { id: ID, issueId: ID, body: {} } }),
      ]),
    );
    expect(decoded.mutations.map((m) => m.seq)).toEqual([57, 58]);
  });

  it.each([
    ['an empty batch', request([])],
    ['a gap between seqs', request([call(1), call(3)])],
    ['seqs out of order', request([call(2), call(1)])],
    ['a repeated seq', request([call(1), call(1)])],
    ['seq 0', request([call(0)])],
    ['a mutation without input', request([{ seq: 1, op: 'debug.touch' }])],
    ['an operation name that is not dotted', request([call(1, { op: 'touch' })])],
    ['an invalid timestamp', request([call(1, { at: 'yesterday' })])],
    [
      'a client id that is not a UUID',
      { clientId: 'tab-1', schemaHash: HASH, mutations: [call(1)] },
    ],
    ['an invalid schema hash', { clientId: ID, schemaHash: 'ABC', mutations: [call(1)] }],
  ])('rejects %s', (_case, body) => {
    expect(() => decodeMutateRequest(body)).toThrow(ProtocolError);
  });

  it(`caps a batch at ${MAX_MUTATIONS_PER_BATCH} mutations`, () => {
    const calls = (n: number) => Array.from({ length: n }, (_, i) => call(i + 1));
    expect(() => decodeMutateRequest(request(calls(MAX_MUTATIONS_PER_BATCH)))).not.toThrow();
    expect(() => decodeMutateRequest(request(calls(MAX_MUTATIONS_PER_BATCH + 1)))).toThrow(
      ProtocolError,
    );
  });
});

describe('mutate response', () => {
  it('round-trips through JSON unchanged', () => {
    fc.assert(
      fc.property(mutateResponse, (res) => {
        expect(decodeMutateResponse(viaJson(res))).toEqual(viaJson(res));
      }),
      propertyOptions,
    );
  });

  it('accepts the sync-protocol.md §4.4 example', () => {
    expect(
      decodeMutateResponse({
        results: [
          { seq: 57, status: 'ok', lastSyncId: 18236 },
          { seq: 58, status: 'error', error: { code: 'NOT_FOUND', message: 'Issue was deleted' } },
        ],
      }).results.map((r) => r.status),
    ).toEqual(['ok', 'error']);
  });

  it.each([
    [
      'results out of seq order',
      {
        results: [
          { seq: 2, status: 'ok', lastSyncId: 1 },
          { seq: 1, status: 'ok', lastSyncId: 1 },
        ],
      },
    ],
    ['an ok result without lastSyncId', { results: [{ seq: 1, status: 'ok' }] }],
    [
      'an error result without a code',
      { results: [{ seq: 1, status: 'error', error: { message: 'no' } }] },
    ],
    [
      'a lowercase error code',
      { results: [{ seq: 1, status: 'error', error: { code: 'not_found', message: 'no' } }] },
    ],
    ['an unknown status', { results: [{ seq: 1, status: 'pending' }] }],
  ])('rejects %s', (_case, body) => {
    expect(() => decodeMutateResponse(body)).toThrow(ProtocolError);
  });
});

describe('mutate error body', () => {
  it('carries lastSeq on SEQ_GAP so the client can resend from lastSeq + 1', () => {
    const body = decodeMutateErrorBody({
      ok: false,
      error: { code: 'SEQ_GAP', message: 'Expected seq 5', correlationId: 'req-1', lastSeq: 4 },
    });
    expect(body.error.lastSeq).toBe(4);
  });

  it('accepts the plain SPEC-003 error shape', () => {
    const body = decodeMutateErrorBody({
      ok: false,
      error: { code: 'CLIENT_OUTDATED', message: 'Reload Surface', correlationId: 'req-2' },
    });
    expect(body.error).toEqual({
      code: 'CLIENT_OUTDATED',
      message: 'Reload Surface',
      correlationId: 'req-2',
    });
  });

  it('decodes a CSRF refusal like any SPEC-003 error, so the client can read its code', () => {
    const body = decodeMutateErrorBody({
      ok: false,
      error: {
        code: CSRF_INVALID,
        message: 'This request is missing its security token. Reload the page and try again.',
        correlationId: 'req-3',
      },
    });
    expect(body.error.code).toBe('CSRF_INVALID');
  });

  it('rejects a success-shaped body', () => {
    expect(() => decodeMutateErrorBody({ ok: true })).toThrow(ProtocolError);
  });
});
