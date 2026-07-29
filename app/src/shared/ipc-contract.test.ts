import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { MenuCommandSchema } from './commands';
import { ContextActionEventSchema } from './context-menu-types';
import { DocEventSchema } from './doc-types';
import { JobEventSchema } from './job-types';
import { PatchProposedEventSchema } from './patch-types';
import { ProjectInfoSchema } from './project-types';
import { AppearanceConfigSchema } from './settings-types';
import { AppInfoSchema, type AppInfo } from './ipc-contract';

const valid: AppInfo = {
  appVersion: '0.0.0',
  platform: 'linux',
  arch: 'x64',
  electronVersion: '39.0.0',
  nodeVersion: '22.19.0',
};

describe('AppInfoSchema', () => {
  it('accepts a well-formed payload', () => {
    expect(Value.Check(AppInfoSchema, valid)).toBe(true);
  });

  it('rejects a payload with a missing field', () => {
    const { nodeVersion: _omitted, ...broken } = valid;
    expect(Value.Check(AppInfoSchema, broken)).toBe(false);
  });

  it('rejects a payload with a wrong type', () => {
    expect(Value.Check(AppInfoSchema, { ...valid, arch: 64 })).toBe(false);
  });
});

describe('main-to-renderer event schemas', () => {
  it('accepts the supported action and state events', () => {
    expect(Value.Check(MenuCommandSchema, 'file:new-document')).toBe(true);
    expect(Value.Check(ContextActionEventSchema, {
      action: 'document:open',
      context: { kind: 'document', documentId: 'doc', path: 'paper.md', isMain: true },
    })).toBe(true);
    expect(Value.Check(DocEventSchema, {
      type: 'external-import',
      documentId: 'doc',
      revision: 2,
    })).toBe(true);
    expect(Value.Check(PatchProposedEventSchema, {
      type: 'patch-proposed',
      patchId: 'patch',
      title: 'Tighten paragraph',
    })).toBe(true);
    expect(Value.Check(JobEventSchema, {
      jobId: 'job',
      op: 'export',
      status: 'progress',
      progress: { done: 1, total: 2 },
    })).toBe(true);
    expect(Value.Check(ProjectInfoSchema, {
      root: '/tmp/paper',
      projectId: 'project',
      mainDocument: 'manuscript.md',
    })).toBe(true);
    expect(Value.Check(AppearanceConfigSchema, {
      theme: 'dark',
      fontFamily: 'serif',
      fontSize: 17,
      editorWidth: 'comfortable',
    })).toBe(true);
  });

  it('rejects malformed or unknown action and state events', () => {
    expect(Value.Check(MenuCommandSchema, 'file:delete-everything')).toBe(false);
    expect(Value.Check(ContextActionEventSchema, {
      action: 'document:open',
      context: { kind: 'conversation', conversationId: 'conv' },
    })).toBe(false);
    expect(Value.Check(DocEventSchema, {
      type: 'external-import',
      documentId: 'doc',
      revision: 0,
    })).toBe(false);
    expect(Value.Check(PatchProposedEventSchema, {
      type: 'patch-proposed',
      patchId: 42,
      title: 'Invalid',
    })).toBe(false);
    expect(Value.Check(JobEventSchema, {
      jobId: 'job',
      op: 'export',
      status: 'unknown',
    })).toBe(false);
    expect(Value.Check(ProjectInfoSchema, {
      root: '/tmp/paper',
      projectId: 'project',
    })).toBe(false);
    expect(Value.Check(AppearanceConfigSchema, {
      theme: 'dark',
      fontFamily: 'serif',
      fontSize: 100,
      editorWidth: 'comfortable',
    })).toBe(false);
  });
});
