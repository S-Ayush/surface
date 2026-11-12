// PLAN-014 S2 (SPEC-014 §4.8, AC-2, E4, D17): the type of an attachment or inline upload comes
// from its bytes, never from what the browser says.
import { describe, expect, it } from 'vitest';
import { SNIFF_BYTES, sniffType } from '../src/files/sniff.js';

const bytes = (...parts: (number[] | string)[]) =>
  Buffer.concat(
    parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part))),
  );

describe('sniffType', () => {
  it.each([
    ['a PNG', bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), 'image/png'],
    ['a JPEG', bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16]), 'image/jpeg'],
    ['a GIF89a', bytes('GIF89a', [1, 0, 1, 0]), 'image/gif'],
    ['a GIF87a', bytes('GIF87a', [1, 0, 1, 0]), 'image/gif'],
    ['a WebP', bytes('RIFF', [4, 0, 0, 0], 'WEBPVP8 '), 'image/webp'],
    ['a PDF', bytes('%PDF-1.7\n%âãÏÓ\n'), 'application/pdf'],
    ['a ZIP', bytes('PK', [3, 4, 20, 0, 0, 0]), 'application/zip'],
    ['an empty ZIP', bytes('PK', [5, 6], new Array<number>(18).fill(0)), 'application/zip'],
    // Office files are ZIPs inside, and are reported as such.
    ['a .docx', bytes('PK', [3, 4], '[Content_Types].xml'), 'application/zip'],
    ['a GZIP', bytes([0x1f, 0x8b, 0x08, 0x00]), 'application/gzip'],
    ['plain text', bytes('Hello, world\n'), 'text/plain'],
    ['UTF-8 text', bytes('Grüße, 世界 🌍\n'), 'text/plain'],
    ['text with a BOM', bytes([0xef, 0xbb, 0xbf], 'hello'), 'text/plain'],
    ['a shell script', bytes('#!/bin/sh\necho hi\n'), 'text/plain'],
    [
      'a RIFF that is not WebP',
      bytes('RIFF', [4, 0, 0, 0], 'WAVEfmt ', [0, 0]),
      'application/octet-stream',
    ],
    ['bytes with a NUL', bytes('abc', [0], 'def'), 'application/octet-stream'],
    ['invalid UTF-8', bytes('abc', [0xc3, 0x28]), 'application/octet-stream'],
    ['UTF-16 text (NULs)', Buffer.from('﻿hello', 'utf16le'), 'application/octet-stream'],
    ['a Windows executable', bytes('MZ', [0x90, 0, 3, 0, 0, 0]), 'application/octet-stream'],
    ['an ELF executable', bytes([0x7f], 'ELF', [2, 1, 1, 0]), 'application/octet-stream'],
  ])('reports %s as its bytes say', (_name, input, type) => {
    expect(sniffType(input)).toBe(type);
  });

  it.each([
    ['SVG', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['HTML', '<!doctype html><html><script>alert(1)</script></html>'],
    ['XML', '<?xml version="1.0"?><root/>'],
  ])('treats %s as text, so it is only ever served as text/plain (E4)', (_name, text) => {
    expect(sniffType(bytes(text))).toBe('text/plain');
  });

  it('never trusts a renamed executable: an "image" with no image bytes is octet-stream', () => {
    // What a browser would call `photo.png`, image/png.
    expect(sniffType(bytes('MZ', [0x90, 0, 3, 0, 0, 0, 4, 0], 'This program'))).toBe(
      'application/octet-stream',
    );
  });

  it('reads the first 8 KB only, allowing a character cut at that boundary', () => {
    // 8 KB of text whose last character, a 3-byte "世", is cut after its first byte.
    const cut = Buffer.concat([
      Buffer.alloc(SNIFF_BYTES - 1, 'a'),
      Buffer.from('世').subarray(0, 1),
    ]);
    expect(sniffType(cut, false)).toBe('text/plain');
    // The same bytes as a whole file end mid-character: not valid UTF-8.
    expect(sniffType(cut, true)).toBe('application/octet-stream');
    // A NUL after the first 8 KB isn't looked at.
    const late = Buffer.concat([Buffer.alloc(SNIFF_BYTES, 'a'), Buffer.from([0])]);
    expect(sniffType(late, false)).toBe('text/plain');
  });

  it('treats a short body as complete', () => {
    expect(sniffType(Buffer.from('世').subarray(0, 2))).toBe('application/octet-stream');
  });
});
