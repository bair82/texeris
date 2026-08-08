import { createModels, type Models } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { moonshotaiProvider } from '@earendil-works/pi-ai/providers/moonshotai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import type { WorkspaceConfig } from '../services/settings';

/**
 * One Models collection registering only the providers we use (plan §10.3).
 * Provider SDKs load lazily; keys resolve from env (MOONSHOT_API_KEY /
 * DEEPSEEK_API_KEY) in dev (plan §4.6).
 */
export function createAppModels(): Models {
  const models = createModels();
  models.setProvider(deepseekProvider());
  models.setProvider(moonshotaiProvider());
  return models;
}

/**
 * Dev/demo hook: TEXERIS_FAUX_PROVIDER=1 swaps the real providers for a
 * scripted in-process provider — the full chat loop works offline, without
 * API keys. Used by the smokes and for offline development.
 *
 * TEXERIS_FAUX_PATCH=1 additionally scripts a propose_patch call with a
 * valid patch against the seeded dev manuscript (offsets are computed from
 * the seed text in devProject.ts), so the patch pipeline is exercisable
 * end-to-end offline. TEXERIS_FAUX_REWIND=1 scripts the same patch turn
 * followed by a plain second turn, so the rewind flow has two completed
 * turn boundaries to pick from.
 */
export function createFauxModels(scripted: string): { models: Models; config: WorkspaceConfig } {
  const faux = fauxProvider({ models: [{ id: 'faux-model' }] });
  const models = createModels();
  models.setProvider(faux.provider);
  if (process.env.TEXERIS_FAUX_PATCH || process.env.TEXERIS_FAUX_REWIND) {
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('propose_patch', {
          baseRevision: 1,
          title: 'Sharpen the terminology',
          summary: 'Use the more precise term in the introduction.',
          groups: [
            {
              explanation: 'terminology: prefer the narrower word',
              changes: [{ from: 110, to: 119, expectedText: 'geometric', insert: 'algebraic' }],
            },
          ],
        }),
      ]),
      fauxAssistantMessage('I proposed a patch replacing one term; please review it.'),
      ...(process.env.TEXERIS_FAUX_REWIND
        ? [fauxAssistantMessage('Nothing further to change.')]
        : []),
    ]);
  } else {
    faux.setResponses([fauxAssistantMessage(scripted)]);
  }
  return {
    models,
    config: {
      modes: {
        fast: { provider: 'faux', model: 'faux-model' },
        deep: { provider: 'faux', model: 'faux-model' },
      },
      spellcheck: { enabled: false, language: 'en-US' },
      appearance: {
        theme: 'dark' as const,
        fontFamily: 'serif' as const,
        fontSize: 16.5,
        editorWidth: 'comfortable' as const,
      },
      patchStyleMode: 'off' as const,
      activeProfileId: null,
    },
  };
}
