// PLAN-014 S2 (SPEC-014 §4.8, AC-4): uploaded file names are cleaned in six steps, and the
// download's Content-Disposition carries them safely (RFC 6266, RFC 8187).
import { describe, expect, it } from 'vitest';
import {
  asciiFallback,
  attachmentDisposition,
  cleanFileName,
  MAX_NAME_BYTES,
} from '../src/files/names.js';

const header = (name: string) => encodeURIComponent(name);
const byteLength = (text: string) => new TextEncoder().encode(text).length;

describe('cleanFileName', () => {
  it.each([
    ['a plain name', header('report.pdf'), 'report.pdf'],
    ['UTF-8', header('Grüße 世界.txt'), 'Grüße 世界.txt'],
    ['an emoji', header('🎉 party.png'), '🎉 party.png'],
    // 1. Undecodable → `file`.
    ['a bad percent sequence', 'report%E0%A4%A.pdf', 'file'],
    ['percent-encoded invalid UTF-8', 'report%C3%28.pdf', 'file'],
    ['raw non-ASCII bytes', 'r\u00e9sum\u00e9.pdf', 'file'],
    ['no header', undefined, 'file'],
    // 2. NFC: "e" + combining acute becomes one "é".
    ['decomposed characters', header('re\u0301sume\u0301.pdf'), 'r\u00e9sum\u00e9.pdf'],
    // 3. The last path part only.
    ['a Unix path', header('../../etc/passwd'), 'passwd'],
    ['a Windows path', header('C:\\Users\\ada\\secret.txt'), 'secret.txt'],
    ['a path ending in a slash', header('folder/'), 'file'],
    // 4. Control and format characters.
    ['a right-to-left override', header('invoice\u202Efdp.exe'), 'invoicefdp.exe'],
    ['zero-width characters', header('a\u200Bb\u200Cc\u200Dd\uFEFF.txt'), 'abcd.txt'],
    ['control characters', header('a\u0000b\u0007c\nd\u007F.txt'), 'abcd.txt'],
    // 5. Ends trimmed.
    ['spaces and dots at the ends', header('  .report.pdf. . '), 'report.pdf'],
    ['a hidden-file dot', header('.env'), 'env'],
    // 6. Nothing left → `file`.
    ['only dots', header('...'), 'file'],
    ['only a bidi override', header('\u202E'), 'file'],
    ['empty', '', 'file'],
  ])('cleans %s', (_name, input, expected) => {
    expect(cleanFileName(input)).toBe(expected);
  });

  it('trims a long run of spaces in time linear in its length (review m3)', () => {
    // 100,000 spaces then a letter: a backtracking trim tries every start, 5·10⁹ steps.
    const spaces = ' '.repeat(100_000);
    const started = performance.now();
    expect(cleanFileName(header(`${spaces}a${spaces}`))).toBe('a');
    expect(cleanFileName(header(`${spaces}a`))).toBe('a');
    // Cut to 255 bytes, the spaces before the kept extension trimmed too.
    expect(cleanFileName(header(`a${spaces}.b`))).toBe('a.b');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('ignores a repeated header', () => {
    expect(cleanFileName(['a.txt', 'b.txt'])).toBe('file');
  });

  it('cuts to 255 bytes at a character boundary, keeping the extension', () => {
    const long = `${'世'.repeat(200)}.pdf`;
    const cleaned = cleanFileName(header(long));
    expect(byteLength(cleaned)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(cleaned.endsWith('.pdf')).toBe(true);
    // 3 bytes a character: 83 of them and ".pdf" is 253 bytes; one more would be 256.
    expect(cleaned).toBe(`${'世'.repeat(83)}.pdf`);
  });

  it('never splits an emoji (a surrogate pair) when cutting', () => {
    const cleaned = cleanFileName(header(`${'a'.repeat(250)}🎉🎉.txt`));
    expect(byteLength(cleaned)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(cleaned).toBe(`${'a'.repeat(250)}.txt`);
    // No half of a surrogate pair left behind.
    expect(cleaned).not.toMatch(/[\uD800-\uDFFF]/);
  });

  it('cuts a name whose "extension" is too long to keep as a whole', () => {
    const cleaned = cleanFileName(header(`a.${'b'.repeat(300)}`));
    expect(byteLength(cleaned)).toBe(MAX_NAME_BYTES);
  });

  it('keeps a name of exactly 255 bytes', () => {
    const exact = `${'x'.repeat(251)}.txt`;
    expect(cleanFileName(header(exact))).toBe(exact);
  });
});

describe('the Content-Disposition for a download', () => {
  it('gives an ASCII-safe fallback and the exact name in filename*', () => {
    expect(attachmentDisposition('report.pdf')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
    expect(attachmentDisposition('Grüße 世界.txt')).toBe(
      `attachment; filename="Gr__e __.txt"; filename*=UTF-8''Gr%C3%BC%C3%9Fe%20%E4%B8%96%E7%95%8C.txt`,
    );
  });

  it('replaces the characters that could end the quoted string, name a path or decode', () => {
    expect(asciiFallback('a"b\\c/d;e%f.txt')).toBe('a_b_c_d_e_f.txt');
    const disposition = attachmentDisposition('x"; filename="evil.html');
    // One quoted fallback, one filename*: the name can't add a parameter.
    expect(disposition).toBe(
      `attachment; filename="x__ filename=_evil.html"; filename*=UTF-8''x%22%3B%20filename%3D%22evil.html`,
    );
  });

  it('percent-encodes every character outside RFC 8187 attr-char in filename*', () => {
    const disposition = attachmentDisposition("it's (1)*.txt");
    expect(disposition.split("filename*=UTF-8''")[1]).toBe('it%27s%20%281%29%2A.txt');
  });

  it('uses one underscore per character, not per byte, in the fallback', () => {
    expect(asciiFallback('🎉.png')).toBe('_.png');
  });
});
