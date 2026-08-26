import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';
import type { Models } from '@earendil-works/pi-ai';
import type { PatchStyleIssue, PatchStyleReview, ProposePatchInput } from '../../shared/patch-types';
import type { PatchStyleMode } from '../../shared/settings-types';
import type { PatchService } from '../services/patch';
import type { WritingProfileService } from '../services/profile';
import type { WorkspaceConfig } from '../services/settings';
import { PATCH_STYLE_CRITIC_PROMPT } from './skills';
import { withProviderRetries } from './models';

const PROMPT_VERSION = 1;

export class PatchStyleGate {
  private pending = new Map<string, { input: ProposePatchInput & { documentId: string }; origin: { conversationId: string; agentRunId: string }; review: PatchStyleReview }>();

  constructor(
    private readonly options: {
      models: Models;
      config: WorkspaceConfig;
      patches: PatchService;
      profiles: WritingProfileService;
      credentials?: { getApiKey(provider: string): string | undefined };
    },
  ) {}

  setPatchService(patches: PatchService): void {
    this.options.patches = patches;
    this.pending.clear();
  }

  async propose(
    runId: string,
    task: string,
    input: ProposePatchInput & { documentId: string },
    origin: { conversationId: string; agentRunId: string },
  ): Promise<
    | { kind: 'stored'; patchId: string; review: PatchStyleReview | null }
    | { kind: 'conflict'; conflict: unknown[] }
    | { kind: 'revise'; review: PatchStyleReview }
  > {
    const preview = this.options.patches.preview(input);
    if (!preview.ok) return { kind: 'conflict', conflict: preview.conflict };
    const mode = this.options.config.patchStyleMode;
    if (mode === 'off' || !hasProse(input)) {
      const stored = this.options.patches.propose(input, origin);
      return 'conflict' in stored ? { kind: 'conflict', conflict: stored.conflict } : { kind: 'stored', patchId: stored.patchId, review: null };
    }
    const review = await this.review(mode, task, input, preview.text);
    const earlier = this.pending.get(runId);
    if (mode === 'revise-once' && review.verdict === 'revise' && !earlier) {
      this.pending.set(runId, { input, origin, review });
      return { kind: 'revise', review };
    }
    if (earlier) this.pending.delete(runId);
    const stored = this.options.patches.propose(input, origin, review);
    return 'conflict' in stored ? { kind: 'conflict', conflict: stored.conflict } : { kind: 'stored', patchId: stored.patchId, review };
  }

  finalize(runId: string): void {
    const pending = this.pending.get(runId);
    if (!pending) return;
    this.pending.delete(runId);
    this.options.patches.propose(pending.input, pending.origin, pending.review);
  }

  private async review(
    mode: Exclude<PatchStyleMode, 'off'>,
    task: string,
    input: ProposePatchInput & { documentId: string },
    text: string,
  ): Promise<PatchStyleReview> {
    const config = this.options.config.modes.fast;
    const model = this.options.models.getModel(config.provider, config.model);
    if (!model) return unavailable(mode, `model not found: ${config.provider}/${config.model}`);
    const payload = {
      task,
      genre: null,
      audience: null,
      writingProfile: this.options.profiles.read('writing-profile'),
      stylePreferences: { negativeParallelism: 'strongly_avoid', additionalPreferences: [] },
      groups: input.groups.map((group, groupIndex) => ({
        groupIndex,
        explanation: group.explanation,
        changes: group.changes.map((change, changeIndex) => {
          const from = change.from ?? Math.max(0, text.indexOf(change.expectedText));
          const to = change.to ?? from + change.expectedText.length;
          return { changeIndex, before: text.slice(Math.max(0, from - 800), from), expectedText: change.expectedText, insert: change.insert, after: text.slice(to, to + 800) };
        }),
      })),
    };
    let ended: AgentMessage[] = [];
    const agent = new Agent({
      initialState: { systemPrompt: PATCH_STYLE_CRITIC_PROMPT, model, tools: [], messages: [] },
      streamFn: (m, c, o) =>
        this.options.models.streamSimple(m, c, withProviderRetries(o)),
      getApiKey: (provider) => this.options.credentials?.getApiKey(provider),
    });
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'agent_end') ended = event.messages;
    });
    try {
      await agent.prompt(JSON.stringify(payload));
      const raw = lastText(ended).replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
      return validateReview(JSON.parse(raw), mode, `${config.provider}/${config.model}`);
    } catch (error) {
      return unavailable(mode, error instanceof Error ? error.message : String(error));
    } finally {
      unsubscribe();
    }
  }
}

function hasProse(input: ProposePatchInput): boolean {
  return input.groups.some((group) => group.changes.some((change) => /[A-Za-zÀ-ž]{3}/.test(change.insert)));
}

function unavailable(mode: Exclude<PatchStyleMode, 'off'>, warning: string): PatchStyleReview {
  return { verdict: 'unavailable', mode, issues: [], promptVersion: PROMPT_VERSION, warning };
}

function lastText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant') return m.content.filter((p) => p.type === 'text').map((p) => p.text).join('');
  }
  return '';
}

function validateReview(value: unknown, mode: Exclude<PatchStyleMode, 'off'>, model: string): PatchStyleReview {
  if (!value || typeof value !== 'object') throw new Error('critic returned non-object JSON');
  const raw = value as { verdict?: unknown; issues?: unknown };
  if (raw.verdict !== 'pass' && raw.verdict !== 'revise') throw new Error('critic returned invalid verdict');
  if (!Array.isArray(raw.issues)) throw new Error('critic returned invalid issues');
  const issues = raw.issues.map((item): PatchStyleIssue => {
    if (!item || typeof item !== 'object') throw new Error('critic returned invalid issue');
    const x = item as Record<string, unknown>;
    if (typeof x.groupIndex !== 'number' || typeof x.changeIndex !== 'number' || typeof x.category !== 'string' || typeof x.span !== 'string' || (x.severity !== 'medium' && x.severity !== 'high') || (x.confidence !== 'medium' && x.confidence !== 'high') || typeof x.reason !== 'string' || typeof x.direction !== 'string') throw new Error('critic returned malformed issue');
    return x as unknown as PatchStyleIssue;
  });
  if (raw.verdict === 'pass' && issues.length > 0) throw new Error('passing critic response contained issues');
  return { verdict: raw.verdict, mode, issues, model, promptVersion: PROMPT_VERSION };
}
