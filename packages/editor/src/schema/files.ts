import { sameDocJson, type DocNodeJSON } from '@surface/domain';
import { fileIdOfSrc, fileSrc } from './links.js';

/** The file id an image or file chip names, or null for any other node or `src`. */
function fileIdOf(node: DocNodeJSON): string | null {
  if (node.type !== 'image' && node.type !== 'file') return null;
  const src = node.attrs?.['src'];
  return typeof src === 'string' ? fileIdOfSrc(src) : null;
}

/**
 * The ids of the uploaded files a document references (images and file chips), once each, in
 * document order. Saving a document claims these (SPEC-014 §4.3).
 */
export function docFileIds(doc: DocNodeJSON): string[] {
  const ids = new Set<string>();
  const visit = (node: DocNodeJSON) => {
    const id = fileIdOf(node);
    if (id !== null) ids.add(id);
    node.content?.forEach(visit);
  };
  visit(doc);
  return [...ids];
}

/**
 * `doc` with every image and file chip naming a key of `renamed` pointed at its value. Saving
 * a document that references another issue's file stores it pointed at this issue's copy
 * (SPEC-014 §4.3, D1).
 */
export function renameFileSrcs(
  doc: DocNodeJSON,
  renamed: ReadonlyMap<string, string>,
): DocNodeJSON {
  if (renamed.size === 0) return doc;
  const visit = (node: DocNodeJSON): DocNodeJSON => {
    const id = fileIdOf(node);
    const to = id === null ? undefined : renamed.get(id);
    const next: DocNodeJSON =
      to === undefined ? node : { ...node, attrs: { ...node.attrs, src: fileSrc(to) } };
    return next.content === undefined ? next : { ...next, content: next.content.map(visit) };
  };
  return visit(doc);
}

/**
 * How `stored` renamed `sent`'s files, when that is all that differs: what the server did to a
 * saved document (`renameFileSrcs`, §4.3), so a client can adopt the copies' ids. An empty map
 * when the two are the same; undefined when anything else differs, or one id became two.
 */
export function fileSrcRenames(
  sent: DocNodeJSON,
  stored: DocNodeJSON,
): Map<string, string> | undefined {
  const ids = (doc: DocNodeJSON): string[] => {
    const found: string[] = [];
    const visit = (node: DocNodeJSON) => {
      const id = fileIdOf(node);
      if (id !== null) found.push(id);
      node.content?.forEach(visit);
    };
    visit(doc);
    return found;
  };
  const from = ids(sent);
  const to = ids(stored);
  if (from.length !== to.length) return undefined;
  const renamed = new Map<string, string>();
  for (const [i, id] of from.entries()) {
    const next = to[i];
    if (next === undefined) return undefined;
    const known = renamed.get(id);
    if (known !== undefined && known !== next) return undefined;
    if (id !== next) renamed.set(id, next);
  }
  return sameDocJson(renameFileSrcs(sent, renamed), stored) ? renamed : undefined;
}
