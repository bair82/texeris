import { Type, type Static } from '@sinclair/typebox';
import {
  ContextScopeSchema,
  type ContextScope,
  type ModelMode,
} from './chat-types';

export interface SkillLaunchOption {
  id: string;
  label: string;
  description: string;
}

export interface SkillSummary {
  id: string;
  version: number;
  name: string;
  description: string;
  defaultMode: ModelMode;
  supportsScopes: Array<ContextScope['kind']>;
  options: SkillLaunchOption[];
}

export const SkillLaunchRequestSchema = Type.Object({
  skillId: Type.String(),
  mode: Type.Union([Type.Literal('fast'), Type.Literal('deep')]),
  scope: ContextScopeSchema,
  optionId: Type.String(),
});
export type SkillLaunchRequest = Static<typeof SkillLaunchRequestSchema>;

export interface SkillLaunchResult {
  conversationId: string;
  runId: string;
  skill: SkillSummary;
}

export const SkillChannels = {
  list: 'texeris:skill-list',
  launch: 'texeris:skill-launch',
} as const;
