/**
 * Syntax highlighting for code blocks (SPEC-013 §2, D17). The node is the headless `codeBlock`
 * (same name and attributes); highlighting is only decorations, so it never changes the stored
 * document. Classes are `hljs-*`, coloured in `editor.css` with theme tokens.
 */
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { common, createLowlight } from 'lowlight';

const lowlight = createLowlight(common);

interface Span {
  readonly from: number;
  readonly to: number;
  readonly className: string;
}

/** The parts of lowlight's hast tree this reads (its own types come from `@types/hast`). */
type HastNode =
  | { readonly type: 'text'; readonly value: string }
  | {
      readonly type: 'element';
      readonly properties: Readonly<Record<string, unknown>>;
      readonly children: readonly HastNode[];
    }
  | { readonly type: 'comment' | 'doctype' | 'root' };

/** Highlight spans as offsets into the block's text. Cached per node object. */
const cache = new WeakMap<PMNode, readonly Span[]>();

function collect(
  nodes: readonly HastNode[],
  offset: number,
  classes: string[],
  out: Span[],
): number {
  let position = offset;
  for (const node of nodes) {
    if (node.type === 'text') {
      if (classes.length > 0) {
        out.push({
          from: position,
          to: position + node.value.length,
          className: classes.join(' '),
        });
      }
      position += node.value.length;
    } else if (node.type === 'element') {
      const own = node.properties['className'];
      const names = Array.isArray(own) ? own.map(String) : [];
      position = collect(node.children, position, [...classes, ...names], out);
    }
  }
  return position;
}

function spansOf(node: PMNode): readonly Span[] {
  const cached = cache.get(node);
  if (cached !== undefined) return cached;
  const language: unknown = node.attrs['language'];
  const spans: Span[] = [];
  if (
    typeof language === 'string' &&
    lowlight.registered(language) &&
    node.textContent.length > 0
  ) {
    const tree = lowlight.highlight(language, node.textContent);
    collect(tree.children, 0, [], spans);
  }
  cache.set(node, spans);
  return spans;
}

export const CodeHighlight = Extension.create({
  name: 'surfaceCodeHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('surfaceCodeHighlight'),
        props: {
          decorations: (state) => {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name !== 'codeBlock') return true;
              for (const span of spansOf(node)) {
                decorations.push(
                  Decoration.inline(pos + 1 + span.from, pos + 1 + span.to, {
                    class: span.className,
                  }),
                );
              }
              return false;
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
