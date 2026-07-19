import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentTools } from './tools';
import { PatchService } from '../services/patch';
import { createProject, ensureDocument, type ProjectContext } from '../services/project';

let root: string;
let ctx: ProjectContext;
let docId: string;
let tools: ReturnType<typeof createAgentTools>;

async function callTool(name: string, params: Record<string, unknown> = {}) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`tool not found: ${name}`);
  }
  const result = await tool.execute('call-1', params as never);
  return result.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-tools-'));
  ctx = createProject(root);
  docId = ensureDocument(ctx, 'manuscript.md');
  ctx.revisions.commit(
    docId,
    [{ from: 0, to: 0, deletedText: '', insertedText: '# Paper\n\n## Intro\n\nAlpha text.\n' }],
    { actor: 'user', source: { kind: 'typing' } },
  );
  tools = createAgentTools(ctx, new PatchService(ctx.db, ctx.revisions), () => null);
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('read-only agent tools (§10.2)', () => {
  it('list_project_documents returns paths, titles, revisions', async () => {
    const out = JSON.parse(await callTool('list_project_documents'));
    expect(out[0]).toMatchObject({ path: 'manuscript.md', currentRevision: 1 });
  });

  it('read_document returns JSON with text, revision and outline', async () => {
    const out = JSON.parse(await callTool('read_document'));
    expect(out.revision).toBe(1);
    expect(out.outline.join('\n')).toContain('Intro');
    expect(out.text).toContain('Alpha text.');
  });

  it('read_document_range returns one section; bad heading lists available ones', async () => {
    const out = JSON.parse(await callTool('read_document_range', { heading: 'Intro' }));
    expect(out.text).toContain('Alpha text.');
    await expect(callTool('read_document_range', { heading: 'Nope' })).rejects.toThrow(
      /Available: Paper, Intro/,
    );
  });

  it('read_revision_changes summarizes changes since a revision', async () => {
    ctx.revisions.commit(
      docId,
      [{ from: 19, to: 24, deletedText: 'Alpha', insertedText: 'Beta' }],
      { actor: 'agent', source: { kind: 'patch' } },
    );
    const out = await callTool('read_revision_changes', { sinceRevision: 1 });
    expect(out).toContain('r2');
    expect(out).toContain('[agent]');
    expect(out).toContain('Beta');
    const none = await callTool('read_revision_changes', { sinceRevision: 2 });
    expect(none).toContain('no changes');
  });

  it('read_project_instructions reads the file or reports its absence', async () => {
    expect(await callTool('read_project_instructions')).toContain('no project-instructions');
    fs.writeFileSync(path.join(root, 'project-instructions.md'), 'Be brief.');
    expect(await callTool('read_project_instructions')).toBe('Be brief.');
  });
});

describe('propose_patch tool', () => {
  it('stores a valid patch as proposed with the run origin', async () => {
    const runContext = { conversationId: 'conv-1', runId: 'run-1' };
    tools = createAgentTools(ctx, new PatchService(ctx.db, ctx.revisions), () => runContext);
    const patches = new PatchService(ctx.db, ctx.revisions);
    const out = JSON.parse(
      await callTool('propose_patch', {
        baseRevision: 1,
        title: 'Rename Alpha',
        summary: 'Alpha → Beta',
        groups: [
          {
            explanation: 'terminology',
            changes: [{ from: 19, to: 24, expectedText: 'Alpha', insert: 'Beta' }],
          },
        ],
      }),
    );
    expect(out.status).toBe('proposed');
    const record = patches.get(out.patchId);
    expect(record?.title).toBe('Rename Alpha');
    const origin = ctx.db
      .prepare('SELECT origin_json FROM patches WHERE id = ?')
      .get(out.patchId) as { origin_json: string };
    expect(JSON.parse(origin.origin_json)).toEqual(runContext);
  });

  it('returns a structured conflict for a bad anchor (not an error)', async () => {
    const out = JSON.parse(
      await callTool('propose_patch', {
        baseRevision: 1,
        title: 'Bad anchor',
        summary: 'mismatch',
        groups: [
          {
            explanation: 'wrong text',
            changes: [{ from: 19, to: 24, expectedText: 'Gamma', insert: 'Beta' }],
          },
        ],
      }),
    );
    expect(out.conflict[0].reason).toBe('expected-text-mismatch');
    expect(out.hint).toContain('read_document');
  });
});
