import profilePrompt from '../../../../docs/prompts/author-voice-profile-extraction.md?raw';
import patchCriticPrompt from '../../../../docs/prompts/patch-style-critic.md?raw';

export interface SkillDefinition {
  id: string;
  version: number;
  name: string;
  description: string;
  defaultMode: 'fast' | 'deep';
  allowedTools: readonly string[];
  resultTypes: readonly string[];
  instructions: string;
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
    allowedTools: [
      'list_project_documents',
      'read_document',
      'read_document_range',
      'list_corpus_sources',
      'read_corpus_source',
      'delegate_task',
      'create_profile_artifacts',
      'activate_writing_profile',
      'propose_patch',
    ],
    resultTypes: ['report', 'profile', 'patch'],
    instructions: profilePrompt + PROFILE_TOOL_GUIDE,
  },
];

export function skillById(id: string | null | undefined): SkillDefinition | null {
  return BUILTIN_SKILLS.find((skill) => skill.id === id) ?? null;
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
