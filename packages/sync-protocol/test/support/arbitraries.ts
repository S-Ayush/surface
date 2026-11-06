import fc from 'fast-check';
import type {
  Ack,
  BootstrapFrame,
  ClientMessage,
  DeltaPacket,
  MutateResponse,
  Row,
  ServerMessage,
  SyncGroup,
} from '../../src/index.js';

/** Fixed seed so runs are reproducible; fast-check prints the seed and path of any failure. */
export const PROPERTY_SEED = 20261106;
export const propertyOptions = { seed: PROPERTY_SEED, numRuns: 200 } as const;

export const uuid = fc.uuid({ version: 7 });
export const syncId = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
export const hash = fc.stringMatching(/^[0-9a-f]{64}$/);
export const modelName = fc.stringMatching(/^[A-Z][A-Za-z0-9]{0,15}$/);
export const opName = fc.stringMatching(/^[a-z][a-zA-Z]{0,8}\.[a-z][a-zA-Z]{0,8}$/);
export const isoTime = fc
  .date({
    min: new Date('2000-01-01T00:00:00Z'),
    max: new Date('2100-01-01T00:00:00Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

export const syncGroup: fc.Arbitrary<SyncGroup> = fc.oneof(
  fc.constant('workspace' as const),
  uuid.map((id) => `team:${id}` as const),
  uuid.map((id) => `user:${id}` as const),
);

/** Field names avoid `id` (set separately) and `__proto__` (not a plain data key). */
const fieldName = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,11}$/).filter((k) => k !== 'id');

export const row: fc.Arbitrary<Row> = fc
  .tuple(uuid, fc.dictionary(fieldName, fc.jsonValue(), { maxKeys: 6 }))
  .map(([id, rest]) => ({ ...rest, id }));

export const bootstrapFrame: fc.Arbitrary<BootstrapFrame> = fc.oneof(
  fc.record({
    t: fc.constant('meta' as const),
    schemaHash: hash,
    lastSyncId: syncId,
    groups: fc.array(syncGroup, { maxLength: 4 }),
    serverTime: isoTime,
  }),
  fc.record({ t: fc.constant('row' as const), m: modelName, d: row }),
  fc.record({ t: fc.constant('end' as const), rows: fc.nat() }),
);

/** A packet without its id; ids are assigned in increasing order by `deltasMessage`. */
const packetBody = fc.oneof(
  fc.record({ a: fc.constantFrom('I' as const, 'U' as const), m: modelName, d: row }),
  fc.record({
    a: fc.constantFrom('A' as const, 'V' as const, 'D' as const),
    m: modelName,
    mid: uuid,
  }),
  fc.record({
    a: fc.constant('G' as const),
    added: fc.array(syncGroup, { maxLength: 3 }),
    removed: fc.array(syncGroup, { maxLength: 3 }),
  }),
);

const ack: fc.Arbitrary<Ack> = fc.record({ clientId: uuid, seq: fc.integer({ min: 1, max: 1e9 }) });

export const deltasMessage = fc
  .record({
    prev: fc.integer({ min: 0, max: 1e12 }),
    bodies: fc.array(packetBody, { maxLength: 20 }),
    gaps: fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 20, maxLength: 20 }),
    ack: fc.array(ack, { maxLength: 3 }),
  })
  .filter(({ bodies, ack }) => bodies.length > 0 || ack.length > 0)
  .map(({ prev, bodies, gaps, ack }) => {
    let id = prev;
    const packets = bodies.map((body, i): DeltaPacket => {
      id += gaps[i] ?? 1;
      return { ...body, id };
    });
    return { t: 'deltas' as const, prev, packets, ack };
  });

export const serverMessage: fc.Arbitrary<ServerMessage> = fc.oneof(
  deltasMessage,
  fc.record({
    t: fc.constant('resync' as const),
    reason: fc.constantFrom('schema' as const, 'too_old' as const, 'groups' as const),
  }),
  fc.constant({ t: 'ping' as const }),
);

export const clientMessage: fc.Arbitrary<ClientMessage> = fc.constant({ t: 'pong' as const });

/** Typed loosely: fast-check's JsonValue differs from Zod's JSONType only in nested `undefined`. */
export const mutateRequest = fc
  .record({
    clientId: uuid,
    schemaHash: hash,
    firstSeq: fc.integer({ min: 1, max: 1e9 }),
    calls: fc.array(
      fc.record({ op: opName, input: fc.jsonValue(), at: fc.option(isoTime, { nil: undefined }) }),
      { minLength: 1, maxLength: 10 },
    ),
  })
  .map(({ clientId, schemaHash, firstSeq, calls }) => ({
    clientId,
    schemaHash,
    mutations: calls.map(({ op, input, at }, i) => ({
      seq: firstSeq + i,
      op,
      input,
      ...(at === undefined ? {} : { at }),
    })),
  }));

export const mutateResponse: fc.Arbitrary<MutateResponse> = fc
  .record({
    firstSeq: fc.integer({ min: 1, max: 1e9 }),
    outcomes: fc.array(
      fc.oneof(
        fc.record({ status: fc.constant('ok' as const), lastSyncId: syncId }),
        fc.record({
          status: fc.constant('error' as const),
          error: fc.record({
            code: fc.constantFrom('NOT_FOUND', 'FORBIDDEN', 'CONFLICT', 'INVALID_INPUT'),
            message: fc.string(),
          }),
        }),
      ),
      { maxLength: 10 },
    ),
  })
  .map(({ firstSeq, outcomes }) => ({
    results: outcomes.map((outcome, i) => ({ ...outcome, seq: firstSeq + i })),
  }));

/** What a value looks like after a JSON round trip (e.g. `-0` becomes `0`). */
export function viaJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}
