/**
 * What `GET /api/ops` and `/api/openapi.json` publish about operations (SPEC-003 §9, §10),
 * generated from the definitions alone, so a new operation needs no per-surface glue (AC-1).
 */
import type { AnyOperation } from './define.js';
import { MAX_FIELDS } from './fields.js';
import { toCompactSchema, toJsonSchema, type CompactSchema, type JsonSchema } from './schema.js';

/** One `GET /api/ops` entry. */
export interface CatalogEntry {
  readonly name: string;
  readonly kind: AnyOperation['kind'];
  readonly domain: string;
  readonly summary: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly input: CompactSchema;
  readonly output: CompactSchema;
  readonly examples: readonly unknown[];
  readonly destructive: boolean;
  readonly deprecated?: { readonly since: string; readonly replacedBy: string };
}

/**
 * Whether an operation is part of the public catalog: what OpenAPI, the released snapshot, MCP
 * and the seed contract test cover. Internal (`debug.*`) and `systemOnly` operations never are
 * (SPEC-003 §3.1, §9).
 */
export function isPublicOperation(def: AnyOperation): boolean {
  return def.internal !== true && def.systemOnly !== true;
}

const entries = new WeakMap<AnyOperation, CatalogEntry>();

export function catalogEntry(def: AnyOperation): CatalogEntry {
  const cached = entries.get(def);
  if (cached) return cached;
  const entry: CatalogEntry = {
    name: def.name,
    kind: def.kind,
    domain: def.domain,
    summary: def.summary,
    description: def.description,
    keywords: def.keywords,
    input: toCompactSchema(def.input, 'input'),
    output: toCompactSchema(def.output, 'output'),
    examples: def.examples,
    destructive: def.destructive,
    ...(def.deprecated ? { deprecated: def.deprecated } : {}),
  };
  entries.set(def, entry);
  return entry;
}

export const MAX_CLIENT_MUTATION_ID_LENGTH = 200;

/**
 * The OpenAPI document: one `POST /api/ops/<name>` path per operation given. `GET
 * /api/openapi.json` passes the public ones (`isPublicOperation`).
 */
export function toOpenApi(
  operations: readonly AnyOperation[],
  info: { readonly version: string },
): Record<string, unknown> {
  const schemas: Record<string, unknown> = { Error: ERROR_SCHEMA };
  const paths: Record<string, unknown> = {};
  for (const def of operations) {
    const input = component(schemas, `${def.name}.input`, toJsonSchema(def.input, 'input'));
    const output = component(schemas, `${def.name}.output`, toJsonSchema(def.output, 'output'));
    paths[`/api/ops/${def.name}`] = {
      post: {
        operationId: def.name,
        summary: def.summary,
        description: def.description,
        tags: [def.domain],
        ...(def.deprecated ? { deprecated: true } : {}),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: requestSchema(input, def.kind === 'mutation'),
              examples: Object.fromEntries(
                def.examples.map((example, i) => [
                  `example${i + 1}`,
                  { value: { input: example } },
                ]),
              ),
            },
          },
        },
        responses: {
          '200': {
            description: 'The operation ran',
            content: { 'application/json': { schema: successSchema(output) } },
          },
          default: { $ref: '#/components/responses/Error' },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Surface operations API',
      version: info.version,
      description:
        'Every operation is POST /api/ops/<name> with { input, fields?, clientMutationId? }. Errors use one shape; see SPEC-003 §9.',
    },
    paths,
    components: {
      schemas,
      responses: {
        Error: {
          // Every code an operation route can answer, the routes' own included (SPEC-003 §9).
          description:
            'INVALID_INPUT 400, INVALID_REQUEST 400 (malformed JSON; 413 or 415 for a body too large or not JSON), UNAUTHENTICATED 401, FORBIDDEN 403, CSRF_INVALID 403 (a signed-in browser request without its CSRF token: refresh it and resend once), UNKNOWN_OPERATION 404, NOT_FOUND 404, CONFLICT 409, CLIENT_OUTDATED 426, RATE_LIMITED 429 (with Retry-After), INTERNAL 500, SETUP_REQUIRED 503 (the workspace is not set up yet), UNAVAILABLE 503 (the server is starting; with Retry-After), INSUFFICIENT_STORAGE 507 (an upload would leave the server almost out of disk space)',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------

/**
 * Adds a generated schema under `components.schemas`, moving its `$defs` alongside it and
 * rewriting `#`-relative references, which would otherwise point at the document root.
 */
function component(schemas: Record<string, unknown>, name: string, schema: JsonSchema): JsonSchema {
  const { $schema: _dialect, $defs, ...root } = schema;
  const base = `#/components/schemas/${name}`;
  for (const [defName, def] of Object.entries($defs ?? {})) {
    if (typeof def === 'object') schemas[`${name}.${defName}`] = rewriteRefs(def, name, base);
  }
  schemas[name] = rewriteRefs(root, name, base);
  return { $ref: base };
}

/** A copy of `schema` with `#` and `#/$defs/…` references pointed into components. */
function rewriteRefs(schema: object, name: string, base: string): Record<string, unknown> {
  const rewriteValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewriteValue);
    return typeof value === 'object' && value !== null ? rewriteObject(value) : value;
  };
  const rewriteObject = (value: object): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (key === '$ref' && typeof child === 'string') {
          if (child === '#') return [key, base];
          const def = /^#\/\$defs\/(.+)$/.exec(child)?.[1];
          if (def !== undefined) return [key, `#/components/schemas/${name}.${def}`];
        }
        return [key, rewriteValue(child)];
      }),
    );
  return rewriteObject(schema);
}

function requestSchema(input: JsonSchema, mutation: boolean): JsonSchema {
  return {
    type: 'object',
    required: ['input'],
    additionalProperties: false,
    properties: {
      input,
      fields: {
        type: 'array',
        items: { type: 'string' },
        maxItems: MAX_FIELDS,
        description: 'Dot-paths that project the result, like ["identifier", "status.name"]',
      },
      ...(mutation
        ? {
            clientMutationId: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_CLIENT_MUTATION_ID_LENGTH,
              description:
                'Makes retries safe: a repeat within 24 h returns the first result without running again',
            },
          }
        : {}),
    },
  };
}

function successSchema(output: JsonSchema): JsonSchema {
  return {
    type: 'object',
    required: ['ok', 'result'],
    properties: {
      ok: { const: true },
      result: output,
      lastSyncId: { type: 'integer' },
      deprecation: {
        type: 'object',
        required: ['replacedBy'],
        properties: { replacedBy: { type: 'string' } },
      },
    },
  };
}

const ERROR_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['ok', 'error'],
  properties: {
    ok: { const: false },
    error: {
      type: 'object',
      required: ['code', 'message', 'correlationId'],
      properties: {
        code: { type: 'string' },
        operation: { type: 'string' },
        message: { type: 'string' },
        correlationId: { type: 'string' },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'message'],
            properties: {
              path: { type: 'array', items: { type: ['string', 'integer'] } },
              message: { type: 'string' },
              hint: { type: 'string' },
            },
          },
        },
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'label'],
            properties: { id: { type: 'string' }, label: { type: 'string' } },
          },
        },
        retryAfter: { type: 'integer' },
      },
    },
  },
};
