// PLAN-013 S1: text extraction for search and the file references of a document (SPEC-013 §4.4,
// SPEC-014 §4.3).
import { EMPTY_DOC } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import { docFileIds, docToText, markdownToDoc } from '../src/schema/index.js';

const A = '0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7b';
const B = '0190f3b2-7c1a-7d4e-9a1b-2c3d4e5f6a7c';

describe('docToText', () => {
  it('joins block texts with newlines: no list prefixes, code kept, image alt, file names', () => {
    const doc = markdownToDoc(
      [
        '# Plan',
        '- first **item**',
        '- [x] done',
        '```ts\nconst x = 1;\nx++;\n```',
        `![Screenshot](/files/${A})`,
        `Read [notes.txt](/files/${B}) twice\\\nline two`,
        '---',
        `![](/files/${A})`,
      ].join('\n\n'),
    );
    expect(docToText(doc)).toBe(
      'Plan\nfirst item\ndone\nconst x = 1;\nx++;\nScreenshot\nRead notes.txt twice\nline two',
    );
  });

  it('gives the empty string for the empty document', () => {
    expect(docToText(EMPTY_DOC)).toBe('');
  });
});

describe('docFileIds', () => {
  it('lists each referenced file once, in document order', () => {
    const doc = markdownToDoc(
      `![a](/files/${B})\n\n[x](/files/${A}) and [y](/files/${B})\n\n> ![c](/files/${A})`,
    );
    expect(docFileIds(doc)).toEqual([B, A]);
    expect(docFileIds(EMPTY_DOC)).toEqual([]);
  });
});
