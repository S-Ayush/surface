import type { DocNodeJSON } from '@surface/domain';
import { stringAttr } from './schema.js';

const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'codeBlock']);

function inlineText(node: DocNodeJSON): string {
  return (node.content ?? [])
    .map((child) => {
      if (child.type === 'text') return child.text ?? '';
      if (child.type === 'hardBreak') return '\n';
      if (child.type === 'file') return stringAttr(child, 'name');
      return '';
    })
    .join('');
}

/**
 * The plain text of a document, for search (SPEC-013 §4.4 "Text extraction"): the texts of its
 * blocks joined by newlines, list items without prefixes, code kept, images as their alt text and
 * file chips as their name. Empty blocks add nothing. The same document always gives the same
 * text. Server-only use (`issue_search_text`, `comment_search_text`).
 */
export function docToText(doc: DocNodeJSON): string {
  const lines: string[] = [];
  const visit = (node: DocNodeJSON) => {
    let text: string | null = null;
    if (TEXT_BLOCKS.has(node.type)) text = inlineText(node);
    else if (node.type === 'image') {
      const alt = node.attrs?.['alt'];
      text = typeof alt === 'string' ? alt : null;
    } else node.content?.forEach(visit);
    if (text !== null && text !== '') lines.push(text);
  };
  visit(doc);
  return lines.join('\n');
}
