import type { DocNodeJSON } from '@surface/domain';
import { fileIdOfSrc } from './links.js';

/**
 * The ids of the uploaded files a document references (images and file chips), once each, in
 * document order. Saving a document claims these (SPEC-014 §4.3).
 */
export function docFileIds(doc: DocNodeJSON): string[] {
  const ids = new Set<string>();
  const visit = (node: DocNodeJSON) => {
    if (node.type === 'image' || node.type === 'file') {
      const src = node.attrs?.['src'];
      const id = typeof src === 'string' ? fileIdOfSrc(src) : null;
      if (id !== null) ids.add(id);
    }
    node.content?.forEach(visit);
  };
  visit(doc);
  return [...ids];
}
