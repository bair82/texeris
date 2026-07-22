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
  const imageAttrs = editor.isActive('image')
    ? editor.getAttributes('image') as { alt?: string; caption?: string | null }
    : null;
  const imagePosition = imageAttrs ? editor.state.selection.from : null;
  const updateImage = (attrs: Record<string, unknown>) => {
    if (imagePosition === null) return;
    // Keep the atom selected while a toolbar input owns DOM focus; otherwise
    // the contextual fields would disappear after the first keystroke.
    editor.chain().updateAttributes('image', attrs).setNodeSelection(imagePosition).run();
  };

  const chain = () => editor.chain().focus();
  const active = (name: string, attrs?: Record<string, unknown>) =>
    editor.isActive(name, attrs) ? 'active' : '';

  /** Insert a footnote ref at the cursor + a definition block after the
   * last existing definition, and land the cursor inside it. Ref and def
   * go out in ONE transaction: the renumber plugin runs after both exist,
   * so the transient unique label maps the pair unambiguously (M1.5 EU6). */
  const insertFootnote = () => {
    let max = 0;
    let refsBefore = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'footnoteRef' || node.type.name === 'footnoteDef') {
        const n = Number.parseInt(String(node.attrs.label), 10);
        if (Number.isFinite(n)) {
          max = Math.max(max, n);
        }
        if (node.type.name === 'footnoteRef' && pos < editor.state.selection.from) {
          refsBefore += 1;
        }
      }
      return true;
    });
    const label = String(max + 1);
    // the new ref's label after renumbering = its index in document order
    const finalLabel = String(refsBefore + 1);
    const { schema } = editor.state;
    const refNode = schema.nodes.footnoteRef.create({ label });
    const defNode = schema.nodes.footnoteDef.create(
      { label },
      schema.nodes.paragraph.create(),
    );
    let tr = editor.state.tr.replaceSelectionWith(refNode);
    // defs stay contiguous: after the last definition, else at the doc end
    let insertAt = tr.doc.content.size;
    tr.doc.descendants((node, pos) => {
      if (node.type.name === 'footnoteDef') {
        insertAt = pos + node.nodeSize;
      }
      return true;
    });
    tr = tr.insert(insertAt, defNode);
    editor.view.dispatch(tr);
    // cursor into the new def — after reordering it may not be the last one
    const target = ((): number | null => {
      let found: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (found === null && node.type.name === 'footnoteDef' && String(node.attrs.label) === finalLabel) {
          found = pos + 2;
          return false;
        }
        return true;
      });
      return found;
    })();
    if (target !== null) {
      chain().setTextSelection(target).scrollIntoView().run();
    }
  };

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
      <button title="Underline" className={active('underline')} onClick={() => chain().toggleMark('underline').run()}>
        <u>U</u>
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
      {editor.isActive('table') && (
        <>
          <button className="tbl-row-add" title="Add row below" onClick={() => chain().addRowAfter().run()}>
            row+
          </button>
          <button className="tbl-col-add" title="Add column right" onClick={() => chain().addColumnAfter().run()}>
            col+
          </button>
          <button className="tbl-row-del" title="Delete row" onClick={() => chain().deleteRow().run()}>
            row−
          </button>
          <button className="tbl-col-del" title="Delete column" onClick={() => chain().deleteColumn().run()}>
            col−
          </button>
          <button title="Delete table" onClick={() => chain().deleteTable().run()}>
            ⌫⊞
          </button>
        </>
      )}
      <button className="footnote-insert" title="Insert footnote" onClick={insertFootnote}>
        [ⁿ]
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
        <button
          title={editor.isActive('link') ? 'Edit link' : 'Link'}
          className={active('link')}
          onClick={() => {
            // editing after creation: prefill with the existing href (EU6)
            setLinkUrl(
              editor.isActive('link')
                ? String(editor.getAttributes('link').href ?? '')
                : '',
            );
            setLinkMode(true);
          }}
        >
          🔗
        </button>
      )}
      {editor.isActive('link') && (
        <button title="Remove link" onClick={() => chain().unsetLink().run()}>
          ⛓️‍💥
        </button>
      )}
      <span className="toolbar-sep" />
      {imageAttrs && (
        <span className="toolbar-image-form">
          <label>
            Alt text
            <input
              aria-label="Image alt text"
              value={imageAttrs.alt ?? ''}
              onChange={(event) => updateImage({ alt: event.target.value })}
            />
          </label>
          <label>
            Caption
            <input
              aria-label="Image caption"
              placeholder="Optional"
              value={imageAttrs.caption ?? ''}
              onChange={(event) => updateImage({ caption: event.target.value || null })}
            />
          </label>
          <button title="Delete image" onClick={() => editor.commands.deleteSelection()}>Delete image</button>
        </span>
      )}
      {imageAttrs && <span className="toolbar-sep" />}
      <button title="Undo" disabled={!editor.can().undo()} onClick={() => chain().undo().run()}>
        ↩
      </button>
      <button title="Redo" disabled={!editor.can().redo()} onClick={() => chain().redo().run()}>
        ↪
      </button>
    </div>
  );
}
