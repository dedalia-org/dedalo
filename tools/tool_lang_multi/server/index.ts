/**
 * tool_lang_multi server module (PHP tool_lang_multi::automatic_translation).
 * PHP delegates to tool_lang::automatic_translation after its own gate, so the
 * server behavior is identical — the "multi" is a client-side affordance (the JS
 * fires one call per target lang). Config is tool_lang's (`configFrom`): the
 * server engine uri/key here AND the client engine list in the tool context.
 */

import type { ToolResponse, ToolServerModule } from '../../../src/core/tools/module.ts';
import { runAutomaticTranslation } from '../../../src/core/tools/translation.ts';

const CONFIG_FROM = 'tool_lang';

export const tool: ToolServerModule = {
	name: 'tool_lang_multi',
	configFrom: CONFIG_FROM,
	apiActions: {
		automatic_translation: {
			permission: null,
			gatedInHandler:
				'authorizeRecordAccess(...) inside runAutomaticTranslation (src/core/tools/translation.ts) — the same write door as tool_lang (grammar, section floor 1, the dd128-aware pair, the write scope), since PHP delegates here too (closure Step 3 req 10; TOOLS-10).',
			handler: async (ctx) => (await runAutomaticTranslation(ctx, CONFIG_FROM)) as ToolResponse,
		},
	},
};
