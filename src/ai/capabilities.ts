/**
 * The server's AI capability flags: which AI entry points this deployment can
 * ACTUALLY offer. The client hides an entry point unless its flag is true, so a
 * deployment without a working model shows no dead buttons.
 *
 * The flags are computed from configuration only (no network call, no DB read),
 * so they are cheap to evaluate on every page load. They are shipped to the
 * client as page_globals.ai_capabilities (src/core/resolve/environment.ts).
 */

import { readEnv } from '../config/env.ts';
import { readString } from '../config/readers.ts';
import { agentModelCatalog, ModelCatalogError } from './agent/model_catalog.ts';
import { isRagEnabled } from './rag/rag_enabled.ts';

/** The three AI entry points the client may show. */
export interface AiCapabilities {
	/** The assistant chat (tool_assistant): needs the HTTP switch AND at least one usable model. */
	assistant: boolean;
	/** Semantic search: needs RAG on AND a REAL embedding sidecar (not the hash fallback). */
	semantic: boolean;
	/** Object identification (tool_identify): hidden until it is redesigned. */
	identify: boolean;
}

/**
 * Whether the assistant can be offered.
 *
 * - DEDALO_AGENT_HTTP_ENABLED must be the literal 'true' (the operator's switch).
 * - The model catalog must resolve to at least one entry. "No model" means the
 *   assistant has nothing to talk to, so it must be hidden.
 * - An invalid catalog (ModelCatalogError) is fail-closed: the assistant is
 *   disabled, never partially offered. Any other error is a bug and propagates.
 */
function assistantAvailable(): boolean {
	if (readEnv('DEDALO_AGENT_HTTP_ENABLED') !== 'true') return false;
	try {
		return agentModelCatalog().length > 0;
	} catch (error) {
		if (error instanceof ModelCatalogError) return false;
		throw error;
	}
}

/**
 * Whether semantic search can be offered.
 *
 * Without a sidecar endpoint, getEmbeddingProvider() silently falls back to
 * DeterministicHashProvider. That provider is an offline placeholder, NOT a
 * real embedding model, so semantic search is only offered when the sidecar is
 * configured and has an endpoint.
 */
function semanticAvailable(): boolean {
	if (!isRagEnabled()) return false;
	if (readString('DEDALO_RAG_EMBEDDING_PROVIDER').trim().toLowerCase() !== 'sidecar') return false;
	return readString('DEDALO_RAG_EMBEDDING_ENDPOINT').trim() !== '';
}

/** The AI capability flags for this deployment, computed from configuration. */
export function aiCapabilities(): AiCapabilities {
	return {
		assistant: assistantAvailable(),
		semantic: semanticAvailable(),
		// identify is hidden until it is redesigned. Keep this false even if its
		// configuration looks complete: the entry point must not reach users yet.
		identify: false,
	};
}

/**
 * The AI tools that a capability flag gates. A tool NOT listed here is not an AI
 * entry point and is always offered. This is the ONE chokepoint: getUserTools
 * applies it, so every door that lists or grants a tool (toolbar, section
 * buttons, menu, tool_request's grant gate) inherits the same hiding.
 */
const CAPABILITY_GATED_TOOLS: Readonly<Record<string, keyof AiCapabilities>> = {
	tool_assistant: 'assistant',
	tool_identify: 'identify',
};

/** Whether a tool may be offered on this deployment (see CAPABILITY_GATED_TOOLS). */
export function toolOfferedByCapabilities(toolName: string, capabilities: AiCapabilities): boolean {
	const flag = CAPABILITY_GATED_TOOLS[toolName];
	if (flag === undefined) return true;
	return capabilities[flag] === true;
}
