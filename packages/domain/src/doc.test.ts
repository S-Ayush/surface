// PLAN-013 S1: document constants and derived reaction ids (SPEC-013 §4.2, §4.4).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DOC_MAX_BYTES,
  DOC_SCHEMA_VERSION,
  docJsonBytes,
  EMPTY_DOC,
  isDocJson,
  reactionId,
  sameDocJson,
} from './doc.js';
import { sha1, utf8Bytes, utf8Length } from './sha1.js';
import { uuidv5 } from './uuid.js';

const V5 = z.uuid({ version: 'v5' });
/** Fixed seed so runs are reproducible; fast-check prints the seed of any failure. */
const PROPERTY_OPTIONS = { seed: 20261112, numRuns: 300 } as const;
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

describe('EMPTY_DOC', () => {
  it('is one empty paragraph, as the editor stores an empty document', () => {
    expect(EMPTY_DOC).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });

  it('is frozen all the way down, so sharing it is safe', () => {
    expect(Object.isFrozen(EMPTY_DOC)).toBe(true);
    expect(Object.isFrozen(EMPTY_DOC.content)).toBe(true);
    expect(Object.isFrozen(EMPTY_DOC.content?.[0])).toBe(true);
  });
});

describe('document limits', () => {
  it('starts the schema version at 1 and sets the D14 size limits', () => {
    expect(DOC_SCHEMA_VERSION).toBe(1);
    expect(DOC_MAX_BYTES).toEqual({ comment: 51_200, description: 204_800 });
  });

  it('measures the UTF-8 bytes of the JSON', () => {
    expect(docJsonBytes(EMPTY_DOC)).toBe(JSON.stringify(EMPTY_DOC).length);
    // "é" is 2 bytes and "👍" 4 in UTF-8; the JSON adds two quotes.
    expect(docJsonBytes('é👍')).toBe(8);
    expect(docJsonBytes(undefined)).toBe(0);
  });
});

describe('isDocJson', () => {
  it('accepts a document root, with or without content', () => {
    expect(isDocJson(EMPTY_DOC)).toBe(true);
    expect(isDocJson({ type: 'doc' })).toBe(true);
  });

  it('refuses anything that is not a document root', () => {
    for (const value of [
      null,
      undefined,
      '# Markdown',
      [],
      { type: 'paragraph' },
      { type: 'doc', content: 'text' },
      [{ type: 'doc' }],
    ]) {
      expect(isDocJson(value)).toBe(false);
    }
  });
});

describe('sameDocJson (SPEC-011 D17)', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { a: 1, b: 2 }, content: [{ type: 'text', text: 'Hi' }] },
    ],
  };

  it('is true for the same document with keys in another order, as jsonb gives them back', () => {
    const reordered = {
      content: [
        { content: [{ text: 'Hi', type: 'text' }], attrs: { b: 2, a: 1 }, type: 'paragraph' },
      ],
      type: 'doc',
    };
    expect(sameDocJson(doc, reordered)).toBe(true);
    expect(sameDocJson(reordered, doc)).toBe(true);
  });

  it('is false when the text, an attribute, a key or the node order differs', () => {
    const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    expect(
      sameDocJson(doc, { ...doc, content: [{ ...doc.content[0], attrs: { a: 1, b: 3 } }] }),
    ).toBe(false);
    expect(sameDocJson(doc, { ...doc, content: [{ ...doc.content[0], marks: [] }] })).toBe(false);
    expect(
      sameDocJson(
        { type: 'doc', content: [paragraph('a'), paragraph('b')] },
        { type: 'doc', content: [paragraph('b'), paragraph('a')] },
      ),
    ).toBe(false);
    expect(sameDocJson(paragraph('a'), paragraph('A'))).toBe(false);
  });

  it('treats a key holding undefined as absent, as JSON does', () => {
    expect(sameDocJson({ type: 'doc', attrs: undefined }, { type: 'doc' })).toBe(true);
  });

  it('tells arrays, objects, null and missing values apart', () => {
    expect(sameDocJson([], {})).toBe(false);
    expect(sameDocJson(null, {})).toBe(false);
    expect(sameDocJson(undefined, EMPTY_DOC)).toBe(false);
    expect(sameDocJson(null, null)).toBe(true);
    expect(sameDocJson([1, 2], [1, 2, 3])).toBe(false);
  });

  it('agrees with comparing key-sorted JSON, for any JSON value', () => {
    const sorted = (value: unknown): string =>
      JSON.stringify(value, (_key, v: unknown) =>
        v === null || typeof v !== 'object' || Array.isArray(v)
          ? v
          : Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))),
      );
    // Shuffling the keys of a value keeps it equal; JSON values from one generator may differ.
    const shuffle = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(shuffle)
        : typeof value === 'object' && value !== null
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([k, v]) => [k, shuffle(v)]),
            )
          : value;
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        expect(sameDocJson(a, shuffle(a))).toBe(true);
        expect(sameDocJson(a, b)).toBe(sorted(a) === sorted(b));
      }),
      PROPERTY_OPTIONS,
    );
  });
});

describe('sha1 and utf8Bytes', () => {
  it.each([
    ['', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
    ['abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '84983e441c3bd26ebaae4aa1f95129e5e54670f1',
    ],
    // Vectors from node:crypto: multi-byte UTF-8, a 64-byte block, a lone surrogate (U+FFFD).
    ['é👍', '161fc0aad8bdb341eaddf98b86d1552ebfed3813'],
    ['a'.repeat(64), '0098ba824b5c16427bd7a1122a5a442a25ec644d'],
    ['a\ud800b', 'c3693aea616c886c93746deab3d42921ca20f04e'],
  ])('hashes %j like FIPS 180-4', (input, expected) => {
    expect(hex(sha1(utf8Bytes(input)))).toBe(expected);
  });

  it('encodes UTF-8 like encodeURIComponent does', () => {
    // The domain package has no TextEncoder type; encodeURIComponent is the platform's UTF-8.
    const reference = (text: string) =>
      Array.from(encodeURIComponent(text).matchAll(/%([0-9A-F]{2})|./g), ([char, byte]) =>
        byte === undefined ? char.charCodeAt(0) : parseInt(byte, 16),
      );
    fc.assert(
      // Well-formed strings only (encodeURIComponent throws on a lone surrogate, covered above).
      fc.property(fc.string({ unit: 'grapheme', maxLength: 50 }), (text) => {
        expect(Array.from(utf8Bytes(text))).toEqual(reference(text));
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('counts UTF-8 bytes without encoding, lone surrogates as U+FFFD', () => {
    expect(utf8Length('a\uD800b\uDC00')).toBe(utf8Bytes('a\uD800b\uDC00').length);
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 50 }), (text) => {
        expect(utf8Length(text)).toBe(utf8Bytes(text).length);
      }),
      PROPERTY_OPTIONS,
    );
  });
});

describe('uuidv5', () => {
  it('matches the RFC 9562 and Python vectors', () => {
    const dns = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    expect(uuidv5('www.example.com', dns)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    expect(uuidv5('python.org', dns)).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('rejects a namespace that is not a UUID', () => {
    expect(() => uuidv5('x', 'not-a-uuid')).toThrow(TypeError);
  });
});

describe('reactionId', () => {
  const comment = '0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7b';
  const issue = '0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7c';
  const ada = '0190f3b2-7c1a-7d4e-9a1b-000000000001';
  const bob = '0190f3b2-7c1a-7d4e-9a1b-000000000002';

  it('is a UUIDv5 that is the same every time, whatever the case of the ids', () => {
    const id = reactionId(comment, ada, '👍');
    expect(V5.safeParse(id).success).toBe(true);
    expect(reactionId(comment, ada, '👍')).toBe(id);
    expect(reactionId(comment.toUpperCase(), ada.toUpperCase(), '👍')).toBe(id);
    // Pinned (cross-checked with node:crypto): stored reaction ids depend on it, so a change
    // here is a data migration.
    expect(id).toBe('fd5928e2-8348-50e3-a2ea-c5500a3f2407');
  });

  it('differs when the subject, the user or the emoji differ', () => {
    const ids = new Set([
      reactionId(comment, ada, '👍'),
      reactionId(issue, ada, '👍'),
      reactionId(comment, bob, '👍'),
      reactionId(comment, ada, '🎉'),
      reactionId(comment, ada, '👍🏽'),
    ]);
    expect(ids.size).toBe(5);
  });

  it('never collides for distinct inputs', () => {
    const uuid = fc.uuid();
    const emoji = fc.constantFrom('👍', '👎', '🎉', '❤️', '👍🏽', '🇫🇷', '👨‍👩‍👧');
    fc.assert(
      fc.property(fc.tuple(uuid, uuid, emoji), fc.tuple(uuid, uuid, emoji), (a, b) => {
        fc.pre(a.join() !== b.join());
        expect(reactionId(...a)).not.toBe(reactionId(...b));
      }),
      PROPERTY_OPTIONS,
    );
  });
});
