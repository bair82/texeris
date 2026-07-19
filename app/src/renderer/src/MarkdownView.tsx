import type { ReactNode } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

/**
 * Minimal Markdown → React renderer for chat messages (assistant and user).
 * Supports the common chat subset: headings, emphasis, lists, code,
 * blockquotes, links, tables. Unknown nodes degrade to their text content.
 * No dangerouslySetInnerHTML — everything goes through React elements.
 */

const processor = unified().use(remarkParse).use(remarkGfm);

interface MdNode {
  type: string;
  children?: MdNode[];
  value?: string;
  depth?: number;
  ordered?: boolean;
  url?: string;
  lang?: string | null;
}

let keyCounter = 0;
const key = () => `md-${keyCounter++}`;

function renderInline(node: MdNode): ReactNode {
  switch (node.type) {
    case 'text':
      return node.value ?? '';
    case 'emphasis':
      return <em key={key()}>{(node.children ?? []).map(renderInline)}</em>;
    case 'strong':
      return <strong key={key()}>{(node.children ?? []).map(renderInline)}</strong>;
    case 'delete':
      return <s key={key()}>{(node.children ?? []).map(renderInline)}</s>;
    case 'inlineCode':
      return <code key={key()}>{node.value ?? ''}</code>;
    case 'link':
      return (
        <a key={key()} href={node.url} title={node.url} target="_blank" rel="noreferrer">
          {(node.children ?? []).map(renderInline)}
        </a>
      );
    case 'break':
      return <br key={key()} />;
    default:
      return (node.children ?? []).map(renderInline);
  }
}

function renderBlock(node: MdNode): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p key={key()}>{(node.children ?? []).map(renderInline)}</p>;
    case 'heading': {
      const Tag = `h${Math.min(Math.max(node.depth ?? 2, 1), 6)}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return <Tag key={key()}>{(node.children ?? []).map(renderInline)}</Tag>;
    }
    case 'code':
      return (
        <pre key={key()}>
          <code className={node.lang ? `language-${node.lang}` : undefined}>
            {node.value ?? ''}
          </code>
        </pre>
      );
    case 'blockquote':
      return (
        <blockquote key={key()}>{(node.children ?? []).map(renderBlock)}</blockquote>
      );
    case 'list': {
      const items = (node.children ?? []).map((item) => (
        <li key={key()}>{(item.children ?? []).map(renderBlock)}</li>
      ));
      return node.ordered ? <ol key={key()}>{items}</ol> : <ul key={key()}>{items}</ul>;
    }
    case 'table': {
      const [head, ...body] = node.children ?? [];
      return (
        <table key={key()}>
          {head && (
            <thead>
              <tr>
                {(head.children ?? []).map((cell) => (
                  <th key={key()}>{(cell.children ?? []).map(renderInline)}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {body.map((row) => (
              <tr key={key()}>
                {(row.children ?? []).map((cell) => (
                  <td key={key()}>{(cell.children ?? []).map(renderInline)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case 'thematicBreak':
      return <hr key={key()} />;
    default:
      return (node.children ?? []).map(renderBlock);
  }
}

export default function MarkdownView({ text }: { text: string }) {
  const tree = processor.runSync(processor.parse(text)) as unknown as MdNode;
  keyCounter = 0;
  return <div className="markdown-view">{(tree.children ?? []).map(renderBlock)}</div>;
}
