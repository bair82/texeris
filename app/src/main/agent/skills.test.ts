import { describe, expect, it } from 'vitest';
import evalsRaw from '../../../../docs/evals/conservative-rewrite.json?raw';
import verbalTicksEvalsRaw from '../../../../docs/evals/llm-verbal-ticks.json?raw';
import {
  BUILTIN_SKILLS,
  launchableSkills,
  skillById,
} from './skills';

describe('built-in skills', () => {
  it('exposes only skills with a complete launch contract', () => {
    expect(launchableSkills()).toEqual([
      expect.objectContaining({
        id: 'conservative-rewrite',
        version: 1,
        defaultMode: 'fast',
        supportsScopes: ['selection', 'section', 'document'],
      }),
      expect.objectContaining({
        id: 'llm-verbal-ticks',
        version: 1,
        defaultMode: 'fast',
        supportsScopes: ['selection', 'section', 'document'],
      }),
    ]);
    expect(launchableSkills()[0].options.map((option) => option.id)).toEqual([
      'light',
      'shorten',
      'flow',
      'repetition',
    ]);
    expect(launchableSkills()[1].options.map((option) => option.id)).toEqual([
      'audit',
      'audit-rewrite',
    ]);
  });

  it('keeps rewrite prompts bounded and rejects unknown focus options', () => {
    const skill = skillById('conservative-rewrite');
    expect(skill?.launchPrompt?.('shorten')).toContain(
      'without removing claims, evidence, qualifications',
    );
    expect(() => skill?.launchPrompt?.('embellish')).toThrow(/unsupported/);
    expect(skill?.instructions).toContain('do not manufacture a patch');
    expect(skill?.instructions).toContain('Preserve Pandoc citation markers');
  });

  it('does not declare tool names twice or grant raw filesystem tools', () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(new Set(skill.allowedTools).size).toBe(skill.allowedTools.length);
      expect(skill.allowedTools).not.toContain('shell');
      expect(skill.allowedTools).not.toContain('filesystem');
    }
  });

  it('ships failure-oriented rewrite evaluation fixtures', () => {
    const fixtures = JSON.parse(evalsRaw) as Array<{
      id: string;
      required: string[];
      forbidden: string[];
    }>;
    expect(fixtures.map((fixture) => fixture.id)).toEqual([
      'preserve-qualification-and-citation',
      'preserve-specialist-term',
      'prefer-no-op',
      'selection-boundary',
    ]);
    expect(fixtures.every((fixture) => fixture.required.length && fixture.forbidden.length)).toBe(true);
  });

  it('makes verbal-tick auditing contextual and audit-first', () => {
    const skill = skillById('llm-verbal-ticks');
    expect(skill?.launchPrompt?.('audit')).toContain('Do not call propose_patch');
    expect(skill?.launchPrompt?.('audit-rewrite')).toContain('only for high-confidence cases');
    expect(() => skill?.launchPrompt?.('rewrite-everything')).toThrow(/unsupported/);
    expect(skill?.instructions).toContain('as forbidden by itself');
    expect(skill?.instructions).toContain('Do not infer that text was AI-generated');
    expect(skill?.instructions).toContain('Prefer a missed weak candidate');
  });

  it('ships positive and false-positive verbal-tick fixtures', () => {
    const fixtures = JSON.parse(verbalTicksEvalsRaw) as Array<{
      id: string;
      disposition: 'finding' | 'no-finding';
      required: string[];
      forbidden: string[];
    }>;
    expect(fixtures).toHaveLength(6);
    expect(fixtures.filter((fixture) => fixture.disposition === 'finding')).toHaveLength(3);
    expect(fixtures.filter((fixture) => fixture.disposition === 'no-finding')).toHaveLength(3);
    expect(fixtures.every((fixture) => fixture.required.length && fixture.forbidden.length)).toBe(true);
  });
});
