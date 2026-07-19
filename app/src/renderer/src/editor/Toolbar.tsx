import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';

/**
 * Formatting toolbar for the rendered mode — Word-like actions for people
 * who don't write Markdown. Everything maps to Tiptap commands; the
 * canonical Markdown stays the source of truth underneath.
 */
export default function Toolbar({ editor }: { editor: Editor }) {
  // Re-render on every transaction so active states stay current.
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    editor.on('transaction', bump);
    return () => {
      editor.off('transaction', bump);
    };
  }, [editor]);

  const [linkMode, setLinkMode] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  const chain = () => editor.chain().focus();
  const active = (name: string, attrs?: Record<string, unknown>) =>
    editor.isActive(name, attrs) ? 'active' : '';

  const applyLink = () => {
    const href = linkUrl.trim();
    if (href) {
      if (editor.state.selection.empty) {
        chain().insertContent(`<a href="${href}">${href}</a>`).run();
      } else {
        chain().setLink({ href }).run();
      }
    }
    setLinkMode(false);
    setLinkUrl('');
  };

  return (
    <div className="toolbar">
      <button title="Bold" className={active('bold')} onClick={() => chain().toggleBold().run()}>
        <strong>B</strong>
      </button>
      <button title="Italic" className={active('italic')} onClick={() => chain().toggleItalic().run()}>
        <em>I</em>
      </button>
      <button title="Strikethrough" className={active('strike')} onClick={() => chain().toggleStrike().run()}>
        <s>S</s>
      </button>
      <button title="Inline code" className={active('code')} onClick={() => chain().toggleCode().run()}>
        {'</>'}
      </button>
      <span className="toolbar-sep" />
      <button title="Heading 1" className={active('heading', { level: 1 })} onClick={() => chain().toggleHeading({ level: 1 }).run()}>
        H1
      </button>
      <button title="Heading 2" className={active('heading', { level: 2 })} onClick={() => chain().toggleHeading({ level: 2 }).run()}>
        H2
      </button>
      <button title="Heading 3" className={active('heading', { level: 3 })} onClick={() => chain().toggleHeading({ level: 3 }).run()}>
        H3
      </button>
      <button title="Paragraph" className={active('paragraph')} onClick={() => chain().setParagraph().run()}>
        ¶
      </button>
      <span className="toolbar-sep" />
      <button title="Bullet list" className={active('bulletList')} onClick={() => chain().toggleBulletList().run()}>
        •≡
      </button>
      <button title="Numbered list" className={active('orderedList')} onClick={() => chain().toggleOrderedList().run()}>
        1≡
      </button>
      <button title="Blockquote" className={active('blockquote')} onClick={() => chain().toggleBlockquote().run()}>
        ❝
      </button>
      <button
        title="Insert table"
        onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      >
        ⊞
      </button>
      <span className="toolbar-sep" />
      {linkMode ? (
        <span className="toolbar-link-form">
          <input
            autoFocus
            placeholder="https://…"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                applyLink();
              } else if (e.key === 'Escape') {
                setLinkMode(false);
              }
            }}
          />
          <button onClick={applyLink}>Set</button>
        </span>
      ) : (
        <button title="Link" className={active('link')} onClick={() => setLinkMode(true)}>
          🔗
        </button>
      )}
      {editor.isActive('link') && (
        <button title="Remove link" onClick={() => chain().unsetLink().run()}>
          ⛓️‍💥
        </button>
      )}
      <span className="toolbar-sep" />
      <button title="Undo" disabled={!editor.can().undo()} onClick={() => chain().undo().run()}>
        ↩
      </button>
      <button title="Redo" disabled={!editor.can().redo()} onClick={() => chain().redo().run()}>
        ↪
      </button>
    </div>
  );
}
