import * as fs from 'node:fs';
import * as path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { PatchService } from '../services/patch';
import type { ProjectContext } from '../services/project';
import type { CorpusService } from '../services/corpus';
import type { WritingProfileService } from '../services/profile';
import type { AgentCoordinator, SubagentRole } from './coordinator';
import { createGeneratedDocument } from '../services/documents';
import { summarizeChangesSince } from './changes';
import { extractHeadings, sliceSection } from './markdown';

/**
 * Base agent tools: project/document reads plus propose_patch, the only prose
 * mutation path. Skills may add narrowly scoped corpus, profile-artifact,
 * delegation, and metadata tools. No raw fs or shell access is exposed.
 *
 * Schemas use pi-ai's re-exported TypeBox (`Type` from pi-ai), which is the
 * dialect the runtime validates against. Each tool is typed by its schema so
 * `execute` params are fully typed.
 *
 * Document reads return JSON — the model needs the exact `text` field to
 * compute patch offsets reliably.
 */

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
  from: Type.Optional(
    Type.Integer({ minimum: 0, description: 'Optional; omit — the app locates expectedText itself' }),
  ),
  to: Type.Optional(Type.Integer({ minimum: 0 })),
  expectedText: Type.String({
    description:
      'The exact text to replace, quoted verbatim from the document (must match byte-for-byte)',
  }),
  insert: Type.String({ description: 'Replacement text (empty string deletes)' }),
  prefixContext: Type.Optional(
    Type.String({
      description: 'Verbatim text right before the target; needed only when expectedText occurs more than once',
    }),
  ),
  suffixContext: Type.Optional(
    Type.String({
      description: 'Verbatim text right after the target; needed only when expectedText occurs more than once',
    }),
  ),
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
  /** Current editor document for this run; absent in older unit-test callers. */
  documentId?: string;
  task?: string;
  skillId?: string;
}

export interface AgentToolExtensions {
  conversationId?: string;
  skillId?: string;
  corpus?: CorpusService;
  profiles?: WritingProfileService;
  coordinator?: AgentCoordinator;
  propose?: (
    runId: string,
    task: string,
    input: Parameters<PatchService['propose']>[0],
    origin: { conversationId: string; agentRunId: string },
  ) => Promise<
    | { kind: 'stored'; patchId: string; review: unknown }
    | { kind: 'conflict'; conflict: unknown[] }
    | { kind: 'revise'; review: unknown }
  >;
  verifyApproval?: (conversationId: string, quote: string) => boolean;
  onProfileArtifacts?: (artifacts: { reportDocumentId: string; writingProfileDocumentId: string; intellectualProfileDocumentId: string }) => void;
}

export function createAgentTools(
  project: ProjectContext,
  patches: PatchService,
  getRunContext: () => RunContext | null,
  extensions: AgentToolExtensions = {},
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

  const resolveDocId = (documentId?: string): string =>
    documentId ?? getRunContext()?.documentId ?? mainDocId();

  const listDocuments: AgentTool<typeof EmptyParams> = {
    name: 'list_project_documents',
    label: 'List project documents',
    description:
      'List the Markdown documents in this project with their current revision ids.',
    parameters: EmptyParams,
    async execute() {
      const rows = project.db
        .prepare(
          `SELECT id, path, title, current_revision FROM documents
           WHERE trashed_at IS NULL ORDER BY path`,
        )
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
      const summary = summarizeChangesSince(project.db, docId, params.sinceRevision);
      return textResult(summary?.text ?? '(no changes since that revision)', {
        changeCount: summary?.changeCount ?? 0,
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
      'Propose structured edits to a document. The ONLY way to change text. For each change, quote the exact text to replace in expectedText — offsets are located for you; add prefixContext/suffixContext only if the quoted text occurs more than once. Changes are reviewed by the user before application — do not claim they are applied.',
    parameters: ProposePatchParams,
    async execute(_id, params) {
      const runContext = getRunContext();
      const origin = runContext
        ? { conversationId: runContext.conversationId, agentRunId: runContext.runId }
        : {};
      const patchInput = {
        documentId: resolveDocId(params.documentId),
        baseRevision: params.baseRevision,
        title: params.title,
        summary: params.summary,
        groups: params.groups,
      };
      if (runContext && extensions.propose) {
        const gated = await extensions.propose(
          runContext.runId,
          runContext.task ?? '',
          patchInput,
          origin as { conversationId: string; agentRunId: string },
        );
        if (gated.kind === 'conflict') return jsonResult({ conflict: gated.conflict, hint: 're-read the document and regenerate with exact anchors' });
        if (gated.kind === 'revise') return jsonResult({ status: 'revision-required', styleReview: gated.review, hint: 'Revise the patch in the original context and call propose_patch once more. Do not repeat the flagged construction.' });
        return jsonResult({ patchId: gated.patchId, status: 'proposed', styleReview: gated.review });
      }
      const result = patches.propose(
        patchInput,
        origin,
      );
      if ('conflict' in result) {
        // Expected outcome, not an error: the agent re-reads and adjusts.
        return jsonResult({
          conflict: result.conflict,
          hint: 'a change did not validate: quote expectedText exactly as it appears in the document (verbatim, including whitespace); if it occurs more than once, add prefixContext/suffixContext. Call read_document and regenerate if unsure.',
        });
      }
      return jsonResult({ patchId: result.patchId, status: 'proposed' });
    },
  };

  const tools: AgentTool<any>[] = [listDocuments, readDocument, readRange, readChanges, readInstructions, proposePatch];
  if (extensions.profiles) {
    const profiles = extensions.profiles;
    tools.push({
      name: 'read_writing_profile', label: 'Read writing profile',
      description: 'Read the active compact writing profile.', parameters: EmptyParams,
      async execute() { return textResult(profiles.read('writing-profile') ?? '(no active writing profile)'); },
    }, {
      name: 'read_writing_style_report', label: 'Read writing style report',
      description: 'Read the extensive evidence-backed report behind the active writing profile.', parameters: EmptyParams,
      async execute() { return textResult(profiles.read('writing-style-report') ?? '(no active writing profile)'); },
    }, {
      name: 'read_intellectual_profile', label: 'Read intellectual profile',
      description: 'Read the active intellectual profile only when the task materially concerns the user’s expressed philosophical or political commitments.', parameters: EmptyParams,
      async execute() { return textResult(profiles.read('intellectual-profile') ?? '(no active writing profile)'); },
    });
  }
  const grantId = extensions.conversationId && extensions.corpus
    ? extensions.corpus.grantForConversation(project, extensions.conversationId)
    : null;
  if (grantId && extensions.corpus) {
    const corpus = extensions.corpus;
    const ListCorpusParams = Type.Object({});
    const ReadCorpusParams = Type.Object({ sourceId: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1000, maximum: 40000 })) });
    const listCorpus: AgentTool<typeof ListCorpusParams> = {
      name: 'list_corpus_sources', label: 'List profile corpus',
      description: 'List the immutable source snapshot selected for this profile conversation.', parameters: ListCorpusParams,
      async execute() { return jsonResult(corpus.list(project, grantId)); },
    };
    const readCorpus: AgentTool<typeof ReadCorpusParams> = {
      name: 'read_corpus_source', label: 'Read corpus source',
      description: 'Read a bounded range from one converted Markdown corpus source.', parameters: ReadCorpusParams,
      async execute(_id, params) { return jsonResult(corpus.read(project, grantId, params.sourceId, params.offset ?? 0, params.limit ?? 20000)); },
    };
    const MetadataParams = Type.Object({ title: Type.String(), author: Type.Optional(Type.String()), publicEvidence: Type.String() });
    const metadata: AgentTool<typeof MetadataParams> = {
      name: 'lookup_publication_metadata', label: 'Look up publication metadata',
      description: 'Query public scholarly catalogues for a public-looking work. publicEvidence must explain why sending the title is authorized.', parameters: MetadataParams,
      async execute(_id, params) {
        if (!params.publicEvidence.trim()) throw new Error('public-looking evidence is required');
        const query = encodeURIComponent([params.title, params.author].filter(Boolean).join(' '));
        const [crossref, openalex] = await Promise.all([
          fetch(`https://api.crossref.org/works?query.bibliographic=${query}&rows=3`).then((r) => r.ok ? r.json() : { error: r.status }),
          fetch(`https://api.openalex.org/works?search=${query}&per-page=3`).then((r) => r.ok ? r.json() : { error: r.status }),
        ]);
        return jsonResult({ crossref, openalex });
      },
    };
    tools.push(listCorpus, readCorpus, metadata);
    if (extensions.coordinator) {
      const DelegateParams = Type.Object({
        role: Type.Union([Type.Literal('conversion-reviewer'), Type.Literal('metadata-researcher'), Type.Literal('corpus-analyst')]),
        task: Type.String(),
      });
      tools.push({
        name: 'delegate_task', label: 'Delegate bounded task',
        description: 'Delegate a bounded conversion, metadata, or corpus-analysis task to an isolated child agent. Its structured result returns here; children cannot delegate.',
        parameters: DelegateParams,
        async execute(_id, params: any) {
          const run = getRunContext();
          if (!run) throw new Error('delegation is only available during an agent run');
          const result = await extensions.coordinator!.delegate({
            parentRunId: run.runId,
            conversationId: run.conversationId,
            role: params.role as SubagentRole,
            task: params.task,
            tools: [listCorpus, readCorpus, metadata],
          });
          return jsonResult(result, result);
        },
      });
    }
    if (extensions.profiles && extensions.skillId === 'writing-profile') {
      const CreateArtifactsParams = Type.Object({
        writingStyleReport: Type.String(), writingProfile: Type.String(), intellectualProfile: Type.String(),
      });
      tools.push({
        name: 'create_profile_artifacts', label: 'Create profile artifacts',
        description: 'Create the three initial reviewable Markdown profile documents. Use once after analysis and any necessary user questions.',
        parameters: CreateArtifactsParams,
        async execute(_id, params: any) {
          const run = getRunContext();
          if (!run) throw new Error('profile artifact creation requires an active run');
          const origin = { conversationId: run.conversationId, agentRunId: run.runId };
          const report = createGeneratedDocument(project, 'writing-style-report.md', params.writingStyleReport, origin);
          const writing = createGeneratedDocument(project, 'writing-profile.md', params.writingProfile, origin);
          const intellectual = createGeneratedDocument(project, 'intellectual-profile.md', params.intellectualProfile, origin);
          extensions.onProfileArtifacts?.({
            reportDocumentId: report.id,
            writingProfileDocumentId: writing.id,
            intellectualProfileDocumentId: intellectual.id,
          });
          return jsonResult({ report, writingProfile: writing, intellectualProfile: intellectual });
        },
      });
      const ActivateParams = Type.Object({ reportDocumentId: Type.String(), writingProfileDocumentId: Type.String(), intellectualProfileDocumentId: Type.String(), userApproval: Type.String() });
      tools.push({
        name: 'activate_writing_profile', label: 'Activate writing profile',
        description: 'Snapshot reviewed profile documents globally. Call only after explicit user approval in this conversation and quote that approval in userApproval.',
        parameters: ActivateParams,
        async execute(_id, params: any) {
          const run = getRunContext();
          if (!run || run.skillId !== 'writing-profile') throw new Error('profile activation is restricted to the writing-profile skill');
          if (!params.userApproval.trim()) throw new Error('explicit user approval is required');
          if (!extensions.verifyApproval?.(run.conversationId, params.userApproval.trim())) {
            throw new Error('userApproval must quote the latest user message verbatim');
          }
          return jsonResult(extensions.profiles!.activate(project, params));
        },
      });
    }
  }
  return tools;
}
