/**
 * `DocView`: a stored document as React elements, with no editor (SPEC-013 §4.4, AC-14). Comment
 * lists render hundreds of these, so it never mounts TipTap. It follows the same rules as
 * `validateDoc`: a link renders only if it passes the link rule, an image or file only as
 * `/files/<uuid>`; anything else shows as its text. It never throws on a bad document.
 */
import type { DocMarkJSON, DocNodeJSON } from '@surface/domain';
import { Fragment, type ReactNode } from 'react';
import { fileIdOfSrc, isAllowedHref, isCodeLanguage } from './schema/links.js';
import './editor.css';

export interface DocViewProps {
  readonly doc: DocNodeJSON;
  /**
   * Called when a checklist box is clicked, with the item's path (child indexes from the root) and
   * the new state. Leave it out for a read-only list; the author rule is the host's (§4.4).
   */
  readonly onToggle?: (path: readonly number[], checked: boolean) => void;
  /** File ids the host knows are gone (E18): their images show a notice. */
  readonly missingFileIds?: ReadonlySet<string>;
  readonly className?: string;
}

export const MISSING_IMAGE_MESSAGE =
  'This image is no longer available. Remove it or upload it again.';

const MAX_DEPTH = 64;

interface Context {
  readonly onToggle: DocViewProps['onToggle'];
  readonly missing: ReadonlySet<string>;
}

function stringAttr(node: DocNodeJSON, name: string): string {
  const value = node.attrs?.[name];
  return typeof value === 'string' ? value : '';
}

function textOf(node: DocNodeJSON): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(textOf).join('');
}

function withMarks(text: string, marks: readonly DocMarkJSON[]): ReactNode {
  return marks.reduceRight<ReactNode>((inner, mark) => {
    switch (mark.type) {
      case 'bold':
        return <strong>{inner}</strong>;
      case 'italic':
        return <em>{inner}</em>;
      case 'underline':
        return <u>{inner}</u>;
      case 'strike':
        return <s>{inner}</s>;
      case 'code':
        return <code>{inner}</code>;
      case 'link': {
        const href = typeof mark.attrs?.['href'] === 'string' ? mark.attrs['href'] : '';
        return isAllowedHref(href) ? (
          <a href={href} target="_blank" rel="noopener noreferrer nofollow">
            {inner}
          </a>
        ) : (
          inner
        );
      }
      default:
        return inner;
    }
  }, text);
}

function children(
  node: DocNodeJSON,
  path: readonly number[],
  depth: number,
  context: Context,
): ReactNode {
  return (node.content ?? []).map((child, index) => (
    <Fragment key={index}>{render(child, [...path, index], depth + 1, context)}</Fragment>
  ));
}

function render(
  node: DocNodeJSON,
  path: readonly number[],
  depth: number,
  context: Context,
): ReactNode {
  if (depth > MAX_DEPTH) return null;
  const inner = () => children(node, path, depth, context);
  switch (node.type) {
    case 'text':
      return withMarks(node.text ?? '', node.marks ?? []);
    case 'paragraph':
      return <p>{inner()}</p>;
    case 'heading': {
      const level = node.attrs?.['level'];
      if (level === 2) return <h2>{inner()}</h2>;
      if (level === 3) return <h3>{inner()}</h3>;
      if (level === 4) return <h4>{inner()}</h4>;
      return <h1>{inner()}</h1>;
    }
    case 'blockquote':
      return <blockquote>{inner()}</blockquote>;
    case 'bulletList':
      return <ul>{inner()}</ul>;
    case 'orderedList':
      return <ol>{inner()}</ol>;
    case 'listItem':
      return <li>{inner()}</li>;
    case 'taskList':
      return (
        <ul data-type="taskList" className="surface-doc-tasks">
          {inner()}
        </ul>
      );
    case 'taskItem': {
      const checked = node.attrs?.['checked'] === true;
      const { onToggle } = context;
      return (
        <li data-type="taskItem" data-checked={checked}>
          <label>
            <input
              type="checkbox"
              checked={checked}
              disabled={onToggle === undefined}
              aria-label={textOf(node).slice(0, 80) || 'Checklist item'}
              onChange={(event) => {
                onToggle?.(path, event.currentTarget.checked);
              }}
            />
          </label>
          <div>{inner()}</div>
        </li>
      );
    }
    case 'codeBlock': {
      const language = stringAttr(node, 'language');
      return (
        <pre>
          <code className={isCodeLanguage(language) ? `language-${language}` : undefined}>
            {textOf(node)}
          </code>
        </pre>
      );
    }
    case 'horizontalRule':
      return <hr />;
    case 'hardBreak':
      return <br />;
    case 'image': {
      const id = fileIdOfSrc(stringAttr(node, 'src'));
      if (id === null) return null;
      if (context.missing.has(id)) return <p role="note">{MISSING_IMAGE_MESSAGE}</p>;
      return <img src={stringAttr(node, 'src')} alt={stringAttr(node, 'alt')} loading="lazy" />;
    }
    case 'file': {
      const src = stringAttr(node, 'src');
      const name = stringAttr(node, 'name');
      if (fileIdOfSrc(src) === null) return name;
      return (
        <a className="surface-doc-file" href={src} download={name}>
          {name}
        </a>
      );
    }
    default:
      return inner();
  }
}

export function DocView({ doc, onToggle, missingFileIds, className }: DocViewProps) {
  const context: Context = { onToggle, missing: missingFileIds ?? new Set() };
  return (
    <div className={className === undefined ? 'surface-doc' : `surface-doc ${className}`}>
      {children(doc, [], 0, context)}
    </div>
  );
}
