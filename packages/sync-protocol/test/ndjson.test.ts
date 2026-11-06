import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeNdjson, encodeNdjsonLine, NdjsonDecoder, ProtocolError } from '../src/index.js';
import { propertyOptions, viaJson } from './support/arbitraries.js';

/** Split `whole` at the given cut points (sorted, deduplicated, clamped to its length). */
function splitAt<T extends { length: number; slice(start: number, end?: number): T }>(
  whole: T,
  cuts: number[],
): T[] {
  const points = [...new Set(cuts.map((c) => Math.min(c, whole.length)))].sort((a, b) => a - b);
  const parts: T[] = [];
  let start = 0;
  for (const point of points) {
    parts.push(whole.slice(start, point));
    start = point;
  }
  parts.push(whole.slice(start));
  return parts;
}

function decodeAll(chunks: (Uint8Array | string)[]): unknown[] {
  const decoder = new NdjsonDecoder();
  return [...chunks.flatMap((chunk) => decoder.push(chunk)), ...decoder.end()];
}

const encoder = new TextEncoder();

describe('NDJSON decoder', () => {
  it('decodes any value sequence however the bytes are chunked, including mid-character', () => {
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue(), { maxLength: 15 }),
        fc.array(fc.nat({ max: 4000 }), { maxLength: 30 }),
        (values, cuts) => {
          const bytes = encoder.encode(values.map(encodeNdjsonLine).join(''));
          expect(decodeAll(splitAt(bytes, cuts))).toEqual(viaJson(values));
        },
      ),
      propertyOptions,
    );
  });

  it('decodes any value sequence however the text is chunked', () => {
    fc.assert(
      fc.property(
        fc.array(fc.jsonValue(), { maxLength: 15 }),
        fc.array(fc.nat({ max: 4000 }), { maxLength: 30 }),
        (values, cuts) => {
          const text = values.map(encodeNdjsonLine).join('');
          expect(decodeAll(splitAt(text, cuts))).toEqual(viaJson(values));
        },
      ),
      propertyOptions,
    );
  });

  it('reassembles a multi-byte character split across byte chunks', () => {
    const bytes = encoder.encode('{"name":"Zoë 🚀"}\n');
    const rocket = bytes.indexOf(0xf0);
    const chunks = [
      bytes.slice(0, rocket + 1),
      bytes.slice(rocket + 1, rocket + 3),
      bytes.slice(rocket + 3),
    ];
    expect(decodeAll(chunks)).toEqual([{ name: 'Zoë 🚀' }]);
  });

  it('accepts CRLF, blank lines, and a last line without a newline', () => {
    expect(decodeAll(['{"a":1}\r\n\n  \n{"a":2}\n', 'null'])).toEqual([{ a: 1 }, { a: 2 }, null]);
  });

  it('returns values as soon as their line is complete', () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push('{"a":1}\n{"a"')).toEqual([{ a: 1 }]);
    expect(decoder.push(':2}')).toEqual([]);
    expect(decoder.push('\n')).toEqual([{ a: 2 }]);
    expect(decoder.end()).toEqual([]);
  });

  it('names the line of invalid JSON without echoing it', () => {
    const decoder = new NdjsonDecoder();
    decoder.push('{"a":1}\n');
    const attempt = () => decoder.push('{"password":"hunter2"\n');
    expect(attempt).toThrow('Invalid NDJSON stream: line 2 is not valid JSON');
  });

  it('rejects a truncated last line at end of stream', () => {
    const decoder = new NdjsonDecoder();
    decoder.push('{"a":1}\n{"a":');
    expect(() => decoder.end()).toThrow(ProtocolError);
  });

  it('rejects malformed UTF-8 instead of silently replacing it', () => {
    const decoder = new NdjsonDecoder();
    expect(() => decoder.push(Uint8Array.of(0x22, 0xff, 0x22, 0x0a))).toThrow(/malformed UTF-8/);
  });

  it('rejects a UTF-8 character cut off at end of stream', () => {
    const decoder = new NdjsonDecoder();
    decoder.push(Uint8Array.of(0x22, 0xe2, 0x82));
    expect(() => decoder.end()).toThrow(/malformed UTF-8/);
  });

  it('bounds the buffered line length, so a stream without newlines cannot exhaust memory', () => {
    const decoder = new NdjsonDecoder({ maxLineLength: 10 });
    expect(decoder.push('"0123456"\n')).toEqual(['0123456']);
    expect(() => decoder.push('"0123456789')).toThrow(/line 2 exceeds 10 characters/);
    const complete = new NdjsonDecoder({ maxLineLength: 10 });
    expect(() => complete.push('"0123456789"\n')).toThrow(/line 1 exceeds 10 characters/);
  });

  it('refuses mixed byte and text chunks', () => {
    const decoder = new NdjsonDecoder();
    decoder.push(encoder.encode('{"a":'));
    expect(() => decoder.push('1}\n')).toThrow(/mixed byte and text chunks/);
  });

  it('refuses data after end', () => {
    const decoder = new NdjsonDecoder();
    decoder.end();
    expect(() => decoder.push('1\n')).toThrow(/data after end/);
  });

  it('decodes an async chunk stream', async () => {
    // Each chunk arrives on a later microtask, like network reads.
    async function* source() {
      for (const text of ['{"t":"meta"}\n{"t":', '"end"}']) {
        yield await Promise.resolve(encoder.encode(text));
      }
    }
    const values: unknown[] = [];
    for await (const value of decodeNdjson(source())) values.push(value);
    expect(values).toEqual([{ t: 'meta' }, { t: 'end' }]);
  });
});

describe('NDJSON encoder', () => {
  it('writes one line per value, even for strings with newlines', () => {
    expect(encodeNdjsonLine({ text: 'a\nb' })).toBe('{"text":"a\\nb"}\n');
  });

  it('rejects values JSON cannot represent', () => {
    expect(() => encodeNdjsonLine(undefined)).toThrow(ProtocolError);
  });
});
