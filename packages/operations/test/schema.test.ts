import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toCompactSchema, toJsonSchema } from '../src/index.js';
import { TeamRef, teamList, teamUpdate } from './fixtures.js';

describe('toJsonSchema', () => {
  it('exports the input as JSON Schema 2020-12 and annotates reference types', () => {
    expect(toJsonSchema(teamUpdate.input)).toMatchInlineSnapshot(`
      {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "properties": {
          "color": {
            "pattern": "^#[0-9a-f]{6}$",
            "type": "string",
          },
          "icon": {
            "type": [
              "string",
              "null",
            ],
          },
          "name": {
            "maxLength": 64,
            "minLength": 1,
            "type": "string",
          },
          "team": {
            "description": "Team key like ENG (any case), or a team id",
            "maxLength": 320,
            "type": "string",
            "x-surface-ref": "TeamRef",
          },
          "timezone": {
            "minLength": 1,
            "type": "string",
          },
        },
        "required": [
          "team",
        ],
        "type": "object",
      }
    `);
  });

  it('exports defaults as optional on the input side and required on the output side', () => {
    const schema = z.object({ limit: z.number().int().default(25) });
    expect(toJsonSchema(schema, 'input').required).toBeUndefined();
    expect(toJsonSchema(schema, 'output').required).toEqual(['limit']);
  });

  it('keeps the reference annotation through optional, nullable and array wrappers', () => {
    const json = toJsonSchema(
      z.object({ a: TeamRef.optional(), b: TeamRef.nullable(), c: z.array(TeamRef) }),
    );
    expect(JSON.stringify(json).match(/"x-surface-ref":"TeamRef"/g)).toHaveLength(3);
  });
});

describe('toCompactSchema', () => {
  it('maps the team.update input to a flat field map', () => {
    expect(toCompactSchema(teamUpdate.input)).toMatchInlineSnapshot(`
      {
        "color": {
          "type": "string",
        },
        "icon": {
          "type": "string|null",
        },
        "name": {
          "type": "string",
        },
        "team": {
          "description": "Team key like ENG (any case), or a team id",
          "required": true,
          "type": "TeamRef",
        },
        "timezone": {
          "type": "string",
        },
      }
    `);
  });

  it('maps a list input with defaults and enums', () => {
    expect(toCompactSchema(teamList.input)).toMatchInlineSnapshot(`
      {
        "cursor": {
          "description": "endCursor from the previous page",
          "type": "string",
        },
        "filter": {
          "description": "Filter model, domain-model §5",
          "type": "object",
        },
        "includeArchived": {
          "default": false,
          "type": "boolean",
        },
        "limit": {
          "default": 25,
          "type": "integer",
        },
        "orderBy": {
          "default": "name",
          "enum": [
            "name",
            "createdAt",
            "updatedAt",
          ],
          "type": "string",
        },
      }
    `);
  });

  it('flattens nested objects and array elements to dot-paths', () => {
    const schema = z.object({
      owner: z.object({ team: TeamRef, note: z.string().optional() }).optional(),
      labels: z.array(z.object({ name: z.string(), color: z.string().nullable() })),
      tags: z.array(z.string()),
      teams: z.array(TeamRef).optional(),
    });
    expect(toCompactSchema(schema)).toEqual({
      owner: { type: 'object' },
      'owner.team': {
        type: 'TeamRef',
        required: true,
        description: 'Team key like ENG (any case), or a team id',
      },
      'owner.note': { type: 'string' },
      labels: { type: 'object[]', required: true },
      'labels[].name': { type: 'string', required: true },
      'labels[].color': { type: 'string|null', required: true },
      tags: { type: 'string[]', required: true },
      teams: { type: 'TeamRef[]' },
    });
  });

  it('describes unions, literals, nullable references and a non-object root', () => {
    expect(
      toCompactSchema(
        z.object({
          by: z.union([z.string(), z.number()]),
          mode: z.literal('fast'),
          lead: TeamRef.nullable(),
        }),
      ),
    ).toEqual({
      by: { type: 'string|number', required: true },
      mode: { type: 'string', required: true, enum: ['fast'] },
      lead: {
        type: 'TeamRef|null',
        required: true,
        description: 'Team key like ENG (any case), or a team id',
      },
    });
    expect(toCompactSchema(z.array(z.uuid()), 'output')).toEqual({
      $: { type: 'string[]', required: true },
    });
  });

  it('exports the output side when asked', () => {
    expect(toCompactSchema(teamList.output, 'output')).toMatchObject({
      nodes: { type: 'object[]', required: true },
      'nodes[].id': { type: 'string', required: true, format: 'uuid' },
      'pageInfo.endCursor': { type: 'string|null', required: true },
      totalCount: { type: 'integer' },
    });
  });
});
