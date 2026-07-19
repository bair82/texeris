import * as fs from 'node:fs';
import * as path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { PatchService } from '../services/patch';
import type { ProjectContext } from '../services/project';
import { extractHeadings, sliceSection } from './markdown';

/**
 * Agent tools v1 (plan §10.2): five read-only tools plus propose_patch, the
 * ONLY write path. No fs, no shell, no web.
 *
 * Schemas use pi-ai's re-exported TypeBox (`Type` from pi-ai), which is the
 * dialect the runtime validates against. Each tool is typed by its schema so
 * `execute` params are fully typed.
 *
 * Document reads return JSON — the model needs the exact `text` field to
 * compute patch offsets reliably.
 */

const PREVIEW = 120;

const ReadDocumentParams = Type.Object({
  documentId: Type.Optional(Type.String()),
});

const ReadRangeParams = Type.Object({
  documentId: Type.Optional(Type.String()),
  heading: Type.String({ description: 'Exact heading text' }),
});

const ReadChangesParams = Type.Object({
  documentId: Type.Optional(Type.String()),
  sinceRevision: Type.Integer({ minimum: 0 }),
});

const EmptyParams = Type.Object({});

const TextChangeSchema = Type.Object({
  from: Type.Integer({ minimum: 0 }),
  to: Type.Integer({ minimum: 0 }),
  expectedText: Type.String({
    description: 'The exact text currently at [from, to) — must match byte-for-byte',
  }),
  insert: Type.String({ description: 'Replacement text (empty string deletes)' }),
  prefixContext: Type.Optional(Type.String()),
  suffixContext: Type.Optional(Type.String()),
});

const ProposePatchParams = Type.Object({
  documentId: Type.Optional(Type.String()),
  baseRevision: Type.Integer({
    minimum: 1,
    description: 'Revision id the changes were computed against (from read_document)',
  }),
  title: Type.String(),
  summary: Type.String(),
  groups: Type.Array(
    Type.Object({
      explanation: Type.String({ description: 'Why this group of changes, for review' }),
      changes: Type.Array(TextChangeSchema, { minItems: 1 }),
    }),
    { minItems: 1 },
  ),
});

function textResult(text: string, details: unknown = {}) {
  return { content: [{ type: 'text' as const, text }], details };
}

function jsonResult(payload: unknown, details: unknown = {}) {
  return textResult(JSON.stringify(payload, null, 2), details);
}

interface DocRow {
  id: string;
  path: string;
  title: string;
  current_revision: number;
}

export interface RunContext {
  conversationId: string;
  runId: string;
}

export function createAgentTools(
  project: ProjectContext,
  patches: PatchService,
  getRunContext: () => RunContext | null,
): AgentTool<any>[] {
  const mainDocId = (): string => {
    const row = project.db
      .prepare('SELECT id FROM documents WHERE path = ?')
      .get(project.project.mainDocument) as { id: string } | undefined;
    if (!row) {
      throw new Error(`main document ${project.project.mainDocument} not registered`);
    }
    return row.id;
  };

  const resolveDocId = (documentId?: string): string => documentId ?? mainDocId();

  const listDocuments: AgentTool<typeof EmptyParams> = {
    name: 'list_project_documents',
    label: 'List project documents',
    description:
      'List the Markdown documents in this project with their current revision ids.',
    parameters: EmptyParams,
    async execute() {
      const rows = project.db
        .prepare('SELECT id, path, title, current_revision FROM documents ORDER BY path')
        .all() as unknown as DocRow[];
      const payload = rows.map((row) => ({
        documentId: row.id,
        path: row.path,
        title: row.title,
        currentRevision: row.current_revision,
      }));
      return jsonResult(payload, { documents: payload });
    },
  };

  const readDocument: AgentTool<typeof ReadDocumentParams> = {
    name: 'read_document',
    label: 'Read document',
    description:
      'Read a document (default: the main manuscript). Returns JSON with the current revision id, heading outline, and the full text. Character offsets anywhere refer to the `text` field.',
    parameters: ReadDocumentParams,
    async execute(_id, params) {
      const docId = resolveDocId(params.documentId);
      const text = project.revisions.getCurrentText(docId);
      const revision = project.revisions.getCurrentRevision(docId);
      const outline = extractHeadings(text).map(
        (h) => `${'  '.repeat(h.level - 1)}- ${h.text}`,
      );
      return jsonResult({ documentId: docId, revision, outline, text }, { documentId: docId, revision });
    },
  };

  const readRange: AgentTool<typeof ReadRangeParams> = {
    name: 'read_document_range',
    label: 'Read document section',
    description:
      'Read one heading-delimited section of a document (default: the main manuscript). Returns JSON with the revision id and the section text. Offsets are relative to the full document, not the section.',
    parameters: ReadRangeParams,
    async execute(_id, params) {
      const docId = resolveDocId(params.documentId);
      const text = project.revisions.getCurrentText(docId);
      const section = sliceSection(text, params.heading);
      const revision = project.revisions.getCurrentRevision(docId);
      if (section === null) {
        const outline = extractHeadings(text).map((h) => h.text);
        throw new Error(
          `heading not found: ${JSON.stringify(params.heading)}. Available: ${outline.join(', ') || '(none)'}`,
        );
      }
      return jsonResult(
        { documentId: docId, revision, heading: params.heading, text: section },
        { documentId: docId, revision },
      );
    },
  };

  const readChanges: AgentTool<typeof ReadChangesParams> = {
    name: 'read_revision_changes',
    label: 'Read revision changes',
    description:
      'List what changed in a document (default: the main manuscript) since a given revision — compact previews of deleted/inserted text per change.',
    parameters: ReadChangesParams,
    async execute(_id, params) {
      const docId = resolveDocId(params.documentId);
      const rows = project.db
        .prepare(
          `SELECT c.seq, c.idx, c.deleted_text, c.inserted_text, r.actor, r.summary
           FROM revision_changes c
           JOIN revisions r ON r.document_id = c.document_id AND r.seq = c.seq
           WHERE c.document_id = ? AND c.seq > ?
           ORDER BY c.seq, c.idx`,
        )
        .all(docId, params.sinceRevision) as unknown as Array<{
        seq: number;
        idx: number;
        deleted_text: string;
        inserted_text: string;
        actor: string;
        summary: string;
      }>;
      const preview = (s: string) =>
        s.length > PREVIEW ? `${s.slice(0, PREVIEW)}…(${s.length} chars)` : s;
      const lines = rows.map(
        (row) =>
          `r${row.seq} [${row.actor}] -${JSON.stringify(preview(row.deleted_text))} +${JSON.stringify(preview(row.inserted_text))}`,
      );
      return textResult(lines.join('\n') || '(no changes since that revision)', {
        changeCount: rows.length,
      });
    },
  };

  const readInstructions: AgentTool<typeof EmptyParams> = {
    name: 'read_project_instructions',
    label: 'Read project instructions',
    description:
      'Read the always-on project instructions (project-instructions.md), if present.',
    parameters: EmptyParams,
    async execute() {
      const file = path.join(project.root, 'project-instructions.md');
      if (!fs.existsSync(file)) {
        return textResult('(no project-instructions.md in this project)');
      }
      return textResult(fs.readFileSync(file, 'utf8'));
    },
  };

  const proposePatch: AgentTool<typeof ProposePatchParams> = {
    name: 'propose_patch',
    label: 'Propose patch',
    description:
      'Propose structured edits to a document. The ONLY way to change text. Offsets are 0-based character indices into the document text (the `text` field from read_document); expectedText must match the current text at [from, to) exactly. Changes are reviewed by the user before application — do not claim they are applied.',
    parameters: ProposePatchParams,
    async execute(_id, params) {
      const runContext = getRunContext();
      const result = patches.propose(
        {
          documentId: resolveDocId(params.documentId),
          baseRevision: params.baseRevision,
          title: params.title,
          summary: params.summary,
          groups: params.groups,
        },
        runContext ?? {},
      );
      if ('conflict' in result) {
        // Expected outcome, not an error: the agent re-reads and regenerates.
        return jsonResult({
          conflict: result.conflict,
          hint: 'the document changed under you or an anchor is wrong — call read_document and regenerate the patch',
        });
      }
      return jsonResult({ patchId: result.patchId, status: 'proposed' });
    },
  };

  return [listDocuments, readDocument, readRange, readChanges, readInstructions, proposePatch];
}
