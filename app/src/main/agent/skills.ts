import profilePrompt from '../../../../docs/prompts/author-voice-profile-extraction.md?raw';
import conservativeRewritePrompt from '../../../../docs/prompts/conservative-rewrite.md?raw';
import verbalTicksPrompt from '../../../../docs/prompts/llm-verbal-ticks.md?raw';
import patchCriticPrompt from '../../../../docs/prompts/patch-style-critic.md?raw';
import type {
  SkillLaunchOption,
  SkillSummary,
} from '../../shared/skill-types';
import type { ContextScope } from '../../shared/chat-types';

export interface SkillDefinition {
  id: string;
  version: number;
  name: string;
  description: string;
  defaultMode: 'fast' | 'deep';
  supportsScopes: readonly ContextScope['kind'][];
  options: readonly SkillLaunchOption[];
  allowedTools: readonly string[];
  resultTypes: readonly string[];
  instructions: string;
  launchPrompt?(optionId: string): string;
}

const PROFILE_TOOL_GUIDE = `

## Texeris execution environment

The corpus is represented by an application-scoped grant. Use
list_corpus_sources and read_corpus_source; never ask for raw filesystem
access. Delegate bounded source-analysis or metadata tasks when useful.
Create the three required artifacts with create_profile_artifacts. They become
ordinary project Markdown documents. After the user has reviewed or edited
them and explicitly approves activation, call activate_writing_profile with
their document ids. Never activate on the user's behalf without that approval.
`;

export const BUILTIN_SKILLS: readonly SkillDefinition[] = [
  {
    id: 'writing-profile',
    version: 1,
    name: 'Build or update writing profile',
    description: 'Analyze previous writing and create reviewable voice and intellectual profiles.',
    defaultMode: 'deep',
    supportsScopes: ['document'],
    options: [],
    allowedTools: [
      'list_project_documents',
      'read_document',
      'read_document_range',
      'read_revision_changes',
      'read_project_instructions',
      'read_writing_profile',
      'read_writing_style_report',
      'read_intellectual_profile',
      'list_corpus_sources',
      'read_corpus_source',
      'lookup_publication_metadata',
      'delegate_task',
      'create_profile_artifacts',
      'activate_writing_profile',
      'propose_patch',
    ],
    resultTypes: ['report', 'profile', 'patch'],
    instructions: profilePrompt + PROFILE_TOOL_GUIDE,
  },
  {
    id: 'conservative-rewrite',
    version: 1,
    name: 'Conservative rewrite',
    description: 'Improve clarity and concision while preserving meaning, qualifications, citations, and voice.',
    defaultMode: 'fast',
    supportsScopes: ['selection', 'section', 'document'],
    options: [
      {
        id: 'light',
        label: 'Light copy-edit',
        description: 'Correct clear grammar and clarity problems with minimal disturbance.',
      },
      {
        id: 'shorten',
        label: 'Shorten',
        description: 'Remove avoidable words and repetition without dropping substance.',
      },
      {
        id: 'flow',
        label: 'Improve flow',
        description: 'Improve sentence and paragraph movement while preserving the argument.',
      },
      {
        id: 'repetition',
        label: 'Reduce repetition',
        description: 'Remove repeated wording or ideas while retaining necessary emphasis.',
      },
    ],
    allowedTools: [
      'read_document',
      'read_document_range',
      'read_project_instructions',
      'read_writing_profile',
      'propose_patch',
    ],
    resultTypes: ['patch'],
    instructions: conservativeRewritePrompt,
    launchPrompt(optionId) {
      const focus: Record<string, string> = {
        light: 'Perform a light copy-edit. Change only clear grammar, clarity, or concision problems.',
        shorten: 'Shorten the scoped text without removing claims, evidence, qualifications, or necessary transitions.',
        flow: 'Improve the flow of the scoped text without changing its argument or making the prose more decorative.',
        repetition: 'Reduce avoidable repetition in the scoped text while preserving deliberate emphasis.',
      };
      const instruction = focus[optionId];
      if (!instruction) throw new Error(`unsupported Conservative rewrite focus: ${optionId}`);
      return `Run Conservative rewrite on the application-selected scope. ${instruction} Use a reviewable patch for every proposed textual change.`;
    },
  },
  {
    id: 'llm-verbal-ticks',
    version: 1,
    name: 'LLM verbal-tick audit',
    description: 'Find formulaic or mechanically repeated phrasing without flattening legitimate academic prose.',
    defaultMode: 'fast',
    supportsScopes: ['selection', 'section', 'document'],
    options: [
      {
        id: 'audit',
        label: 'Audit first',
        description: 'Return numbered findings only; choose any rewrites in the conversation.',
      },
      {
        id: 'audit-rewrite',
        label: 'Audit + rewrite clear cases',
        description: 'Report findings and propose minimal patches only for high-confidence cases.',
      },
    ],
    allowedTools: [
      'read_document',
      'read_document_range',
      'read_project_instructions',
      'read_writing_profile',
      'propose_patch',
    ],
    resultTypes: ['comments', 'patch'],
    instructions: verbalTicksPrompt,
    launchPrompt(optionId) {
      if (optionId === 'audit') {
        return 'Audit the application-selected scope for LLM verbal ticks. Return numbered findings only. Do not call propose_patch during this initial audit.';
      }
      if (optionId === 'audit-rewrite') {
        return 'Audit the application-selected scope for LLM verbal ticks. Return numbered findings, then propose minimal patches only for high-confidence cases.';
      }
      throw new Error(`unsupported LLM verbal-tick mode: ${optionId}`);
    },
  },
];

export function skillById(id: string | null | undefined): SkillDefinition | null {
  return BUILTIN_SKILLS.find((skill) => skill.id === id) ?? null;
}

export function skillSummary(skill: SkillDefinition): SkillSummary {
  return {
    id: skill.id,
    version: skill.version,
    name: skill.name,
    description: skill.description,
    defaultMode: skill.defaultMode,
    supportsScopes: [...skill.supportsScopes],
    options: skill.options.map((option) => ({ ...option })),
  };
}

export function launchableSkills(): SkillSummary[] {
  return BUILTIN_SKILLS
    .filter((skill) => skill.launchPrompt)
    .map(skillSummary);
}

export const PATCH_STYLE_CRITIC_PROMPT = extractCriticSystemPrompt(patchCriticPrompt);

function extractCriticSystemPrompt(markdown: string): string {
  const marker = '## System prompt';
  const end = '## Input message template';
  const startAt = markdown.indexOf(marker);
  const endAt = markdown.indexOf(end);
  if (startAt < 0 || endAt <= startAt) throw new Error('invalid patch critic prompt asset');
  return markdown.slice(startAt + marker.length, endAt).trim();
}
