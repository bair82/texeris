import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFragment } from 'parse5';
import { referencedAssets } from './assets';
import { writePandocHtml } from './pandoc';

const IMAGE_MIME: Record<string, string> = {
  '.avif': 'image/avif', '.gif': 'image/gif', '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
};
const ALLOWED_TAGS = new Set([
  'a', 'blockquote', 'br', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'figcaption',
  'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'li', 'ol', 'p',
  'pre', 's', 'section', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'del', 'caption', 'colgroup', 'col',
]);
const DROP_CONTENT_TAGS = new Set(['audio', 'embed', 'iframe', 'object', 'script', 'style', 'svg', 'video']);
const VOID_TAGS = new Set(['br', 'hr', 'img']);

interface HtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

function safeHref(value: string): boolean {
  return value.startsWith('#') || /^(?:https?:|mailto:)/i.test(value);
}

function sanitizedAttributes(node: HtmlNode): string {
  const tag = node.tagName ?? '';
  const kept: Array<{ name: string; value: string }> = [];
  for (const attr of node.attrs ?? []) {
    const name = attr.name.toLowerCase();
    if (name === 'id' || name === 'class' || name === 'role' || name.startsWith('aria-')) {
      kept.push(attr);
    } else if (tag === 'a' && name === 'href' && safeHref(attr.value)) {
      kept.push(attr);
    } else if (tag === 'a' && name === 'title') {
      kept.push(attr);
    } else if (tag === 'img' && ['alt', 'title', 'width', 'height'].includes(name)) {
      kept.push(attr);
    } else if (tag === 'img' && name === 'src' && /^data:image\/(?:avif|gif|jpe?g|png|webp);base64,/i.test(attr.value)) {
      kept.push(attr);
    } else if (tag === 'img' && name === 'style') {
      const dimensions = attr.value
        .split(';')
        .map((part) => part.trim())
        .filter((part) => /^(?:width|height):\s*\d+(?:\.\d+)?(?:px|%|em|rem|cm|mm|in)?$/i.test(part));
      if (dimensions.length > 0) kept.push({ name, value: `${dimensions.join(';')};` });
    } else if ((tag === 'td' || tag === 'th') && ['colspan', 'rowspan'].includes(name) && /^\d+$/.test(attr.value)) {
      kept.push(attr);
    } else if ((tag === 'td' || tag === 'th') && name === 'style' && /^text-align:\s*(?:left|right|center);?$/i.test(attr.value)) {
      kept.push(attr);
    }
  }
  return kept.map((attr) => ` ${attr.name}="${escapeAttribute(attr.value)}"`).join('');
}

function renderSanitized(node: HtmlNode): string {
  if (node.nodeName === '#text') return escapeHtml(node.value ?? '');
  if (node.nodeName === '#comment') return '';
  const tag = node.tagName?.toLowerCase();
  if (!tag) return (node.childNodes ?? []).map(renderSanitized).join('');
  if (DROP_CONTENT_TAGS.has(tag)) return '';
  const children = (node.childNodes ?? []).map(renderSanitized).join('');
  if (!ALLOWED_TAGS.has(tag)) return children;
  const attrs = sanitizedAttributes(node);
  if (tag === 'img' && !attrs.includes(' src=')) {
    const alt = node.attrs?.find((attr) => attr.name === 'alt')?.value ?? '';
    return alt ? `<span class="omitted-image">[Image: ${escapeHtml(alt)}]</span>` : '';
  }
  return VOID_TAGS.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${children}</${tag}>`;
}

export function sanitizePrintHtml(fragment: string): string {
  const parsed = parseFragment(fragment) as unknown as HtmlNode;
  return (parsed.childNodes ?? []).map(renderSanitized).join('');
}

export function inlineProjectImages(markdown: string, root: string): { markdown: string; warnings: string[] } {
  let output = markdown;
  const warnings: string[] = [];
  for (const relative of referencedAssets(markdown)) {
    const target = path.resolve(root, ...relative.split('/'));
    const rootPrefix = `${path.resolve(root)}${path.sep}`;
    const mime = IMAGE_MIME[path.extname(relative).toLowerCase()];
    if (!target.startsWith(rootPrefix) || !mime || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      warnings.push(`Image ${relative} was omitted because its project asset is unavailable.`);
      continue;
    }
    const dataUri = `data:${mime};base64,${fs.readFileSync(target).toString('base64')}`;
    output = output.replaceAll(relative, dataUri);
  }
  if (/!\[[^\]]*\]\(https?:\/\/|<img\b[^>]*\bsrc=["']https?:\/\//i.test(output)) {
    warnings.push('Remote images were omitted from the PDF; only project-owned image assets are embedded.');
  }
  return { markdown: output, warnings };
}

const PRINT_CSS = `
@page { size: A4 portrait; margin: 25mm 22mm; }
html { color: #111; background: #fff; }
body { margin: 0; font: 11pt/1.45 "Noto Serif", "Liberation Serif", "Times New Roman", serif; }
h1, h2, h3, h4, h5, h6 { break-after: avoid-page; line-height: 1.2; margin: 1.3em 0 0.55em; }
h1 { font-size: 20pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; }
p, blockquote, pre, figure, table { orphans: 3; widows: 3; }
blockquote { border-left: 2px solid #999; margin-left: 0; padding-left: 1em; color: #333; }
pre, code { font-family: "Noto Sans Mono", "Liberation Mono", monospace; }
pre { white-space: pre-wrap; break-inside: avoid-page; padding: 0.7em; background: #f4f4f4; }
table { width: 100%; border-collapse: collapse; break-inside: avoid-page; font-size: 9pt; }
th, td { border: 1px solid #999; padding: 0.35em 0.5em; vertical-align: top; }
img { display: block; max-width: 100%; max-height: 220mm; margin: 0 auto; }
figure { break-inside: avoid-page; margin: 1em 0; text-align: center; }
figcaption { margin-top: 0.45em; font-size: 9.5pt; color: #444; }
a { color: inherit; text-decoration: underline; text-decoration-color: #777; }
.footnotes { font-size: 9pt; } .omitted-image { color: #555; font-style: italic; }
`;

export function buildPdfPrintHtml(
  markdown: string,
  title: string,
  resourceRoot: string,
): { html: string; warnings: string[] } {
  const inlined = inlineProjectImages(markdown, resourceRoot);
  const converted = writePandocHtml(inlined.markdown);
  if (/<img\b[^>]*\bsrc=["']https?:\/\//i.test(converted.html)
    && !inlined.warnings.some((warning) => warning.startsWith('Remote images'))) {
    inlined.warnings.push('Remote images were omitted from the PDF; only project-owned image assets are embedded.');
  }
  const body = sanitizePrintHtml(converted.html);
  return {
    html: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`,
    warnings: [...inlined.warnings, ...converted.warnings],
  };
}
