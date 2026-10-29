/**
 * Gate: the AI capability flags (src/ai/capabilities.ts) — which AI entry points
 * the deployment offers. Pure/offline: every input is a stubbed process env
 * value (readEnv reads process.env before ../private/.env, so explicit values
 * here win over the installation's own file). No DB, no network.
 *
 * Covers: assistant (switch + model catalog, fail-closed on an invalid catalog),
 * semantic (RAG on + real sidecar with endpoint, never the hash fallback),
 * identify (always hidden), and the page_globals / user_tools wiring by source.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aiCapabilities, toolOfferedByCapabilities } from '../../src/ai/capabilities.ts';

/** Every env key the flags read. Saved once, restored after every test. */
const KEYS = [
	'DEDALO_AGENT_HTTP_ENABLED',
	'DEDALO_AGENT_MODELS',
	'ANTHROPIC_API_KEY',
	'AGENT_MODEL',
	'DEDALO_RAG_ENABLED',
	'DEDALO_RAG_EMBEDDING_PROVIDER',
	'DEDALO_RAG_EMBEDDING_ENDPOINT',
] as const;

const saved: Record<string, string | undefined> = {};

beforeAll(() => {
	for (const key of KEYS) saved[key] = process.env[key];
});

afterEach(() => {
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

afterAll(() => {
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

/**
 * Stub the env for one case. Keys not given are set to '' (an explicit empty
 * value, which the readers treat as unset) so the installation's own
 * ../private/.env cannot leak into the case.
 */
function stubEnv(values: Partial<Record<(typeof KEYS)[number], string>>): void {
	for (const key of KEYS) process.env[key] = values[key] ?? '';
}

/** A valid one-model catalog, as an operator would write it. */
const VALID_CATALOG = JSON.stringify([
	{
		id: 'claude',
		label: 'Claude',
		provider: 'anthropic',
		model: 'claude-opus-4-8',
		egress: 'external',
		vision: true,
	},
]);

describe('assistant flag', () => {
	test('hidden when the HTTP switch is off, even with a valid model', () => {
		stubEnv({ DEDALO_AGENT_HTTP_ENABLED: 'false', DEDALO_AGENT_MODELS: VALID_CATALOG });
		expect(aiCapabilities().assistant).toBe(false);
	});

	test('hidden when the switch is unset', () => {
		stubEnv({ DEDALO_AGENT_MODELS: VALID_CATALOG });
		expect(aiCapabilities().assistant).toBe(false);
	});

	test('shown when the switch is on and the catalog has a model', () => {
		stubEnv({ DEDALO_AGENT_HTTP_ENABLED: 'true', DEDALO_AGENT_MODELS: VALID_CATALOG });
		expect(aiCapabilities().assistant).toBe(true);
	});

	test('a missing model yields assistant=false (switch on, no catalog, no key)', () => {
		stubEnv({ DEDALO_AGENT_HTTP_ENABLED: 'true' });
		expect(aiCapabilities().assistant).toBe(false);
	});

	test('the zero-config implicit Anthropic model counts as a model', () => {
		stubEnv({ DEDALO_AGENT_HTTP_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-test-not-real' });
		expect(aiCapabilities().assistant).toBe(true);
	});

	test('an invalid catalog is fail-closed: assistant=false, no throw', () => {
		stubEnv({ DEDALO_AGENT_HTTP_ENABLED: 'true', DEDALO_AGENT_MODELS: 'not json' });
		expect(() => aiCapabilities()).not.toThrow();
		expect(aiCapabilities().assistant).toBe(false);
	});

	test('a catalog that is JSON but not an array is fail-closed', () => {
		stubEnv({ DEDALO_AGENT_HTTP_ENABLED: 'true', DEDALO_AGENT_MODELS: '{"id":"x"}' });
		expect(aiCapabilities().assistant).toBe(false);
	});
});

describe('semantic flag', () => {
	test('hidden when RAG is off, even with a sidecar configured', () => {
		stubEnv({
			DEDALO_RAG_ENABLED: 'false',
			DEDALO_RAG_EMBEDDING_PROVIDER: 'sidecar',
			DEDALO_RAG_EMBEDDING_ENDPOINT: 'http://127.0.0.1:8085',
		});
		expect(aiCapabilities().semantic).toBe(false);
	});

	test('hidden with RAG on but the provider left on the hash fallback', () => {
		stubEnv({
			DEDALO_RAG_ENABLED: 'true',
			DEDALO_RAG_EMBEDDING_PROVIDER: 'deterministic',
			DEDALO_RAG_EMBEDDING_ENDPOINT: 'http://127.0.0.1:8085',
		});
		expect(aiCapabilities().semantic).toBe(false);
	});

	test('hidden with RAG on and sidecar but no endpoint (would silently hash)', () => {
		stubEnv({
			DEDALO_RAG_ENABLED: 'true',
			DEDALO_RAG_EMBEDDING_PROVIDER: 'sidecar',
			DEDALO_RAG_EMBEDDING_ENDPOINT: '   ',
		});
		expect(aiCapabilities().semantic).toBe(false);
	});

	test('shown with RAG on, a sidecar provider and an endpoint', () => {
		stubEnv({
			DEDALO_RAG_ENABLED: 'true',
			DEDALO_RAG_EMBEDDING_PROVIDER: 'sidecar',
			DEDALO_RAG_EMBEDDING_ENDPOINT: 'http://127.0.0.1:8085',
		});
		expect(aiCapabilities().semantic).toBe(true);
	});
});

describe('identify flag', () => {
	test('always false, even when every other AI prerequisite is satisfied', () => {
		stubEnv({
			DEDALO_AGENT_HTTP_ENABLED: 'true',
			DEDALO_AGENT_MODELS: VALID_CATALOG,
			DEDALO_RAG_ENABLED: 'true',
			DEDALO_RAG_EMBEDDING_PROVIDER: 'sidecar',
			DEDALO_RAG_EMBEDDING_ENDPOINT: 'http://127.0.0.1:8085',
		});
		expect(aiCapabilities().identify).toBe(false);
	});
});

describe('wiring (source contract)', () => {
	const repo = join(import.meta.dir, '..', '..');

	test('page_globals carries ai_capabilities from the one module', () => {
		const source = readFileSync(join(repo, 'src/core/resolve/environment.ts'), 'utf8');
		expect(source).toContain(
			"ai_capabilities: (await import('../../ai/capabilities.ts')).aiCapabilities()",
		);
	});

	test('getUserTools is the one chokepoint that applies the tool rule', () => {
		const source = readFileSync(join(repo, 'src/core/tools/registry.ts'), 'utf8');
		expect(source).toContain('toolOfferedByCapabilities(tool.name, capabilities)');
		// Both branches (superuser and profile-granted) must pass through `offered`.
		expect(source.match(/offered\(/g)?.length).toBeGreaterThanOrEqual(2);
	});

	test('client guards: assistant button, semantic probe, identify inspector entry', () => {
		const menu = readFileSync(
			join(repo, 'client/dedalo/core/menu/js/view_default_edit_menu.js'),
			'utf8',
		);
		expect(menu).toContain('page_globals.ai_capabilities?.assistant === true');
		const semantic = readFileSync(
			join(repo, 'client/dedalo/core/search/js/render_semantic.js'),
			'utf8',
		);
		expect(semantic).toContain('is_semantic_enabled');
		const inspector = readFileSync(
			join(repo, 'client/dedalo/core/inspector/js/render_inspector.js'),
			'utf8',
		);
		expect(inspector).toContain('page_globals.ai_capabilities?.identify === true');
	});
});

describe('tool rule', () => {
	test('gated tools follow their flag; ordinary tools are always offered', () => {
		const off = { assistant: false, semantic: false, identify: false };
		const on = { assistant: true, semantic: true, identify: false };
		expect(toolOfferedByCapabilities('tool_assistant', off)).toBe(false);
		expect(toolOfferedByCapabilities('tool_assistant', on)).toBe(true);
		expect(toolOfferedByCapabilities('tool_identify', on)).toBe(false);
		expect(toolOfferedByCapabilities('tool_export', off)).toBe(true);
	});
});
