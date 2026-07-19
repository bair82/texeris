import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ContextManifest,
  ContextScope,
} from '../../shared/chat-types';
import type { ProjectContext } from '../services/project';
import { ensureDocument } from '../services/project';
import type { ChangeSummary } from './changes';
import { extractHeadings, sliceSection } from './markdown';

/**
 * Context assembly v1 (plan §11). Scopes: document / section (+ selection as
 * the WP2 seam). Project instructions always ride along (they are small).
 * Every run stores the returned manifest; truncation = scoped text verbatim
 * + full heading outline + explicit notice.
 */

/** Cheap char budget standing in for a token budget in v1. */
export const DOC_BUDGET_CHARS = 120_000;

export interface AssembledContext {
  contextText: string;
  manifest: ContextManifest;
}

export function assembleContext(
  project: ProjectContext,
  scope: ContextScope,
  budgetChars: number = DOC_BUDGET_CHARS,
): AssembledContext {
  const documentId = ensureDocument(project, project.project.mainDocument);
  const text = project.revisions.getCurrentText(documentId);
  const baseRevision = project.revisions.getCurrentRevision(documentId);
  const notices: string[] = [];
  const items: ContextManifest['items'] = [];

  let body: string;
  let truncated = false;
  const outline = extractHeadings(text);

  if (scope.kind === 'document') {
    if (text.length <= budgetChars) {
      body = text;
    } else {
      truncated = true;
      notices.push(
        `document is ${text.length} chars (budget ${budgetChars}); ` +
          'sending the heading outline only — use read_document_range for sections',
      );
      body = renderOutline(outline);
    }
    items.push({ label: `${project.project.mainDocument} (document)`, chars: body.length });
  } else if (scope.kind === 'section') {
    const section = sliceSection(text, scope.heading);
    if (section === null) {
      notices.push(
        `section ${JSON.stringify(scope.heading)} not found; sending the heading outline instead`,
      );
      body = renderOutline(outline);
    } else {
      body =
        section.length <= budgetChars
          ? section
          : `${section.slice(0, budgetChars)}\n\n[…truncated at ${budgetChars} chars]`;
      truncated = section.length > budgetChars;
      if (truncated) {
        notices.push(`section truncated to ${budgetChars} chars`);
      }
    }
    items.push({
      label: `${project.project.mainDocument} § ${scope.heading}`,
      chars: body.length,
    });
  } else {
    const from = Math.min(scope.from, text.length);
    const to = Math.min(Math.max(scope.to, from), text.length);
    body = text.slice(from, to);
    items.push({
      label: `${project.project.mainDocument} selection [${from}, ${to})`,
      chars: body.length,
    });
  }

  const instructionsPath = path.join(project.root, 'project-instructions.md');
  let instructions = '';
  if (fs.existsSync(instructionsPath)) {
    instructions = fs.readFileSync(instructionsPath, 'utf8');
    items.push({ label: 'project-instructions.md', chars: instructions.length });
  }

  const contextText =
    `<document source="${project.project.mainDocument}" revision="${baseRevision}">\n` +
    body +
    '\n</document>' +
    (instructions ? `\n\n<project-instructions>\n${instructions}\n</project-instructions>` : '') +
    (notices.length ? `\n\n<notices>\n${notices.join('\n')}\n</notices>` : '');

  return {
    contextText,
    manifest: {
      scope,
      documentId,
      items,
      baseRevision,
      truncated,
      notices,
    },
  };
}

function renderOutline(outline: ReturnType<typeof extractHeadings>): string {
  if (outline.length === 0) {
    return '(document has no headings)';
  }
  return outline.map((h) => `${'  '.repeat(h.level - 1)}- ${h.text}`).join('\n');
}

export function buildSystemPrompt(
  assembled: AssembledContext,
  changeSummary: ChangeSummary | 'unchanged' | null = null,
): string {
  const parts = [
    'You are Texeris, an editorial collaborator embedded in the user’s academic writing workspace.',
    'You answer questions about the manuscript and help revise it.',
    'The current document context is below. Use the read tools when you need text outside this context, and read_revision_changes to see what changed recently.',
    'To change text, call propose_patch: for each change, quote the exact text to replace in expectedText — the application locates it (add prefixContext/suffixContext only if the quote is not unique). The user reviews every group before anything is applied. Never claim your changes are applied; they are proposals.',
  ];
  if (changeSummary === 'unchanged') {
    parts.push(
      '<recent-changes>No changes since you last saw the document.</recent-changes>',
    );
  } else if (changeSummary) {
    parts.push(
      `<recent-changes since-revision="${changeSummary.fromRevision}" current-revision="${changeSummary.toRevision}">`,
      'Edits made since you last saw the document:',
      changeSummary.text,
      '</recent-changes>',
    );
  }
  parts.push('', assembled.contextText);
  return parts.join('\n');
}
