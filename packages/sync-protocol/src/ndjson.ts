/**
 * Newline-delimited JSON (one value per line) for the bootstrap stream
 * (sync-protocol.md §4.1). Uses only TextDecoder, so it runs in the client's
 * IDB worker and in Node.
 */
import { ProtocolError } from './errors.js';

/** A bootstrap row line is a few KB; anything this large is a broken stream, not data. */
export const DEFAULT_MAX_LINE_LENGTH = 8 * 1024 * 1024;

/** Serialise one value as an NDJSON line (JSON escapes newlines inside strings). */
export function encodeNdjsonLine(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new ProtocolError('Invalid NDJSON value: not JSON-serialisable');
  return `${json}\n`;
}

/** Marks a blank line; distinct from every JSON value, including `null`. */
const NO_VALUE: unique symbol = Symbol('no value');

export interface NdjsonDecoderOptions {
  /** Longest line accepted, in UTF-16 code units. Default `DEFAULT_MAX_LINE_LENGTH`. */
  maxLineLength?: number;
}

/**
 * Incremental decoder. Chunks may split lines, and byte chunks may split
 * multi-byte UTF-8 characters. Blank lines are skipped and `\r\n` is accepted.
 *
 * Feed either bytes or strings, not both: a string pushed while a partial UTF-8
 * character is pending would be decoded out of order.
 */
export class NdjsonDecoder {
  readonly #maxLineLength: number;
  readonly #text = new TextDecoder('utf-8', { fatal: true });
  #buffer = '';
  #line = 0;
  #kind: 'bytes' | 'text' | undefined;
  #ended = false;

  constructor(options: NdjsonDecoderOptions = {}) {
    this.#maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  }

  /** Add a chunk and return every value completed by it, in order. */
  push(chunk: Uint8Array | string): unknown[] {
    if (this.#ended) throw new ProtocolError('Invalid NDJSON stream: data after end');
    const kind = typeof chunk === 'string' ? 'text' : 'bytes';
    if (this.#kind !== undefined && this.#kind !== kind) {
      throw new ProtocolError('Invalid NDJSON stream: mixed byte and text chunks');
    }
    this.#kind = kind;
    this.#buffer += typeof chunk === 'string' ? chunk : this.#decode(chunk, true);
    return this.#drain();
  }

  /** Signal the end of input and return the final value if the last line had no newline. */
  end(): unknown[] {
    if (this.#ended) return [];
    this.#ended = true;
    if (this.#kind === 'bytes') this.#buffer += this.#decode(new Uint8Array(0), false);
    const values = this.#drain();
    const rest = this.#buffer;
    this.#buffer = '';
    const last = this.#parseLine(rest);
    if (last !== NO_VALUE) values.push(last);
    return values;
  }

  #decode(bytes: Uint8Array, stream: boolean): string {
    try {
      return this.#text.decode(bytes, { stream });
    } catch {
      throw new ProtocolError(`Invalid NDJSON stream: malformed UTF-8 near line ${this.#line + 1}`);
    }
  }

  #drain(): unknown[] {
    const values: unknown[] = [];
    let start = 0;
    let newline = this.#buffer.indexOf('\n', start);
    while (newline !== -1) {
      const value = this.#parseLine(this.#buffer.slice(start, newline));
      if (value !== NO_VALUE) values.push(value);
      start = newline + 1;
      newline = this.#buffer.indexOf('\n', start);
    }
    this.#buffer = start === 0 ? this.#buffer : this.#buffer.slice(start);
    if (this.#buffer.length > this.#maxLineLength) {
      throw new ProtocolError(
        `Invalid NDJSON stream: line ${this.#line + 1} exceeds ${this.#maxLineLength} characters`,
      );
    }
    return values;
  }

  #parseLine(raw: string): unknown {
    this.#line += 1;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length > this.#maxLineLength) {
      throw new ProtocolError(
        `Invalid NDJSON stream: line ${this.#line} exceeds ${this.#maxLineLength} characters`,
      );
    }
    if (line.trim() === '') return NO_VALUE;
    try {
      const value: unknown = JSON.parse(line);
      return value;
    } catch {
      // The line itself is not echoed: it may hold user data (CLAUDE.md rule 6).
      throw new ProtocolError(`Invalid NDJSON stream: line ${this.#line} is not valid JSON`);
    }
  }
}

/** Decode an async stream of chunks (e.g. a Node stream or an async-iterated fetch body). */
export async function* decodeNdjson(
  source: AsyncIterable<Uint8Array | string>,
  options?: NdjsonDecoderOptions,
): AsyncGenerator<unknown, void, undefined> {
  const decoder = new NdjsonDecoder(options);
  for await (const chunk of source) {
    yield* decoder.push(chunk);
  }
  yield* decoder.end();
}
