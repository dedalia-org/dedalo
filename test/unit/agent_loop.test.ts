/**
 * Phase 8 gate: the agent loop — tool-use loop over the ACL-gated handlers.
 *
 * Runs fully OFFLINE via a deterministic SCRIPTED provider (the LLM seam):
 * the script requests real tool calls, the loop executes them against the
 * live DB under the caller's Principal, and the results flow back into the
 * transcript. The DoD assertions: the SAME scripted trajectory yields data
 * for an authorized user and an empty/denied result for a user the human
 * API denies; the iteration cap ends runaway loops; the fail-closed
 * Anthropic provider refuses to construct without credentials.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules): the
// searched/described/RAG-scoped section is now the playground `test3`, whose
// SEVEN canonical records the suite owns and restores (test/helpers/test_data.ts
// ensureCanonicalTest3) — so `total > 0` is a fact of the repo, not of whichever
// install the database happens to hold. The summarizer's tipo is an opaque
// string, rewritten through src/core/test_data/test_tld_tipo_map.json.

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import type {
	AgentAssistantTurn,
	AgentLlmProvider,
	AgentTranscriptEntry,
} from '../../src/ai/agent/llm_provider.ts';
import { runAgent } from '../../src/ai/agent/loop.ts';
import * as realRetrieval from '../../src/ai/rag/retrieval.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { ensureCanonicalTest3 } from '../helpers/test_data.ts';

/**
 * PIN THE EMBEDDING PROVIDER — the header says this gate runs fully OFFLINE, and
 * until 2026-08-30 that was true of the LLM seam only. The RAG tools it drives call
 * `getEmbeddingProvider()`, which reads the MACHINE's config: on a host configured
 * for a sidecar that is not running, `embed()` answers `[]` (its documented
 * fail-closed shape) and every dense retrieval in here was running without a query
 * vector.
 *
 * That used to pass. `denseSearch` bound SQL NULL into `$1::vector`, which does not
 * error, and Reciprocal Rank Fusion scores by POSITION without ever reading the null
 * score — so the tool returned arbitrary records with `is_error: false`, and this
 * gate asserted exactly that. It is AIX-01, and this file was one of its witnesses.
 * Since `assertQueryVector` (P1-14) the same situation is a typed refusal, so the
 * gate now FAILS on a sidecar-configured machine and passes on a bare one — which is
 * the "passes on one machine and nowhere else" shape AGENTS.md forbids.
 *
 * Pinning the deterministic embedder gives every host the same working vector, which
 * is what these assertions are actually about: the tool WIRE (scope/group
 * forwarding, dedup, chunk_index), not the embedder. Restored in afterAll — bun runs
 * every file in one process, and deleting the key would hand the next file the
 * machine's sidecar config instead of what it had.
 */
const PRIOR_EMBEDDING_PROVIDER = process.env.DEDALO_RAG_EMBEDDING_PROVIDER;
process.env.DEDALO_RAG_EMBEDDING_PROVIDER = 'deterministic';

afterAll(() => {
	// assigning undefined coerces to the STRING 'undefined' — only delete truly unsets
	if (PRIOR_EMBEDDING_PROVIDER === undefined) {
		delete process.env.DEDALO_RAG_EMBEDDING_PROVIDER;
	} else {
		process.env.DEDALO_RAG_EMBEDDING_PROVIDER = PRIOR_EMBEDDING_PROVIDER;
	}
});

/** A spread COPY taken at import: what the mocking cases re-install (mock_isolation rule 3). */
const REAL_RETRIEVAL = { ...realRetrieval };
const RETRIEVAL = '../../src/ai/rag/retrieval.ts';
// `mock.module` is process-global and `mock.restore()` does not revert it.
afterEach(() => {
	mock.module(RETRIEVAL, () => REAL_RETRIEVAL);
});

const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

/** The searched section's records are OWNED by the suite, never ambient. */
beforeAll(ensureCanonicalTest3);
const NO_ACCESS: Principal = { userId: 999999, isGlobalAdmin: false, isDeveloper: false };

/** Deterministic provider: plays back a fixed script of assistant turns. */
class ScriptedProvider implements AgentLlmProvider {
	readonly name = 'scripted';
	readonly seenTranscripts: AgentTranscriptEntry[][] = [];
	private turnIndex = 0;

	constructor(private readonly script: AgentAssistantTurn[]) {}

	async createTurn(request: { transcript: AgentTranscriptEntry[] }): Promise<AgentAssistantTurn> {
		this.seenTranscripts.push([...request.transcript]);
		const turn = this.script[Math.min(this.turnIndex, this.script.length - 1)];
		this.turnIndex++;
		return turn as AgentAssistantTurn;
	}
}

/** Script: search the playground section, then answer from the result. */
function searchThenAnswerScript(): AgentAssistantTurn[] {
	return [
		{
			text: '',
			tool_uses: [
				{
					id: 'toolu_1',
					name: 'dedalo_search_section',
					input: { section_tipo: 'test3', limit: 3 },
				},
			],
			stop_reason: 'tool_use',
		},
		{ text: 'FINAL ANSWER', tool_uses: [], stop_reason: 'end_turn' },
	];
}

describe('agent loop (Phase 8 gate — offline scripted provider)', () => {
	test('executes real tool calls under the principal and feeds results back', async () => {
		const provider = new ScriptedProvider(searchThenAnswerScript());
		const run = await runAgent(SUPERUSER, 'How many playground records are there?', provider);

		expect(run.stop).toBe('end_turn');
		expect(run.answer).toBe('FINAL ANSWER');

		// The second model turn saw the REAL tool result from the live DB.
		const secondTranscript = provider.seenTranscripts[1] as AgentTranscriptEntry[];
		const resultsEntry = secondTranscript.find((entry) => entry.role === 'tool_results');
		expect(resultsEntry).toBeDefined();
		const result = (resultsEntry as { results: { content: string; is_error: boolean }[] })
			.results[0];
		expect(result?.is_error).toBe(false);
		// Tool results reach the model as the shared structured envelope.
		const envelope = JSON.parse(result?.content as string) as {
			ok: boolean;
			data: { total: number; hits: unknown[] };
		};
		expect(envelope.ok).toBe(true);
		expect(envelope.data.total).toBeGreaterThan(0);
		expect(envelope.data.hits.length).toBeGreaterThan(0);
	});

	test('a user the human API denies gets NOTHING from the same trajectory (DoD)', async () => {
		const provider = new ScriptedProvider(searchThenAnswerScript());
		const run = await runAgent(NO_ACCESS, 'How many playground records are there?', provider);

		const secondTranscript = provider.seenTranscripts[1] as AgentTranscriptEntry[];
		const resultsEntry = secondTranscript.find((entry) => entry.role === 'tool_results') as {
			results: { content: string; is_error: boolean }[];
		};
		const result = resultsEntry.results[0] as { content: string; is_error: boolean };
		// The tool denies LOUDLY with the typed refusal — `perm.denied`, nothing else. A
		// bare "is_error with some content" also passed an `internal.unexpected` (a crash
		// is not a denial), and an ok envelope with zero hits would hide the ACL verdict.
		expect(result.is_error).toBe(true);
		const envelope = JSON.parse(result.content) as {
			ok: boolean;
			data?: unknown;
			error: { code: string; message: string };
		};
		expect(envelope.ok).toBe(false);
		expect(envelope.data).toBeUndefined();
		expect(envelope.error.code).toBe('perm.denied');
		expect(run.stop).toBe('end_turn');
	});

	test('unknown tools return is_error results (the model can adapt)', async () => {
		const provider = new ScriptedProvider([
			{
				text: '',
				tool_uses: [{ id: 'toolu_x', name: 'not_a_tool', input: {} }],
				stop_reason: 'tool_use',
			},
			{ text: 'ok', tool_uses: [], stop_reason: 'end_turn' },
		]);
		await runAgent(SUPERUSER, 'q', provider);
		const secondTranscript = provider.seenTranscripts[1] as AgentTranscriptEntry[];
		const resultsEntry = secondTranscript.find((entry) => entry.role === 'tool_results') as {
			results: { content: string; is_error: boolean }[];
		};
		expect(resultsEntry.results[0]?.is_error).toBe(true);
	});

	test('the iteration cap ends a runaway loop', async () => {
		// A provider that ALWAYS asks for another tool call.
		const provider = new ScriptedProvider([
			{
				text: '',
				tool_uses: [{ id: 't', name: 'dedalo_describe_node', input: { tipo: 'test3' } }],
				stop_reason: 'tool_use',
			},
		]);
		const run = await runAgent(SUPERUSER, 'loop forever', provider);
		expect(run.stop).toBe('max_iterations');
	});

	test('onEvent reports iteration + tool activity in order (streaming surface feed)', async () => {
		const { summarizeToolArgs } = await import('../../src/ai/agent/loop.ts');
		const provider = new ScriptedProvider(searchThenAnswerScript());
		const events: { type: string; name?: string; ok?: boolean }[] = [];
		await runAgent(SUPERUSER, 'q', provider, {
			onEvent: (event) => events.push(event as { type: string }),
		});
		const types = events.map((event) => event.type);
		expect(types[0]).toBe('iteration');
		expect(types).toContain('tool_use');
		expect(types).toContain('tool_result');
		expect(types.indexOf('tool_use')).toBeLessThan(types.indexOf('tool_result'));
		const toolResult = events.find((event) => event.type === 'tool_result') as { ok: boolean };
		expect(toolResult.ok).toBe(true);
		// the human-readable summary helper is pure and capped
		const summary = summarizeToolArgs({ section_tipo: 'test6813', query: 'x'.repeat(300) });
		expect(summary).toContain('section_tipo=test6813');
		expect(summary.length).toBeLessThanOrEqual(140);
	});

	test('the Anthropic provider fails closed without credentials', async () => {
		// S3-68: the old `if (process.env.ANTHROPIC_API_KEY) return` guard was
		// INVERTED coverage — the no-key error path silently no-oped on any
		// machine that HAS a key (the common case here). Mask the key instead:
		// an empty process-env value beats ../private/.env in readEnv and the
		// provider treats '' as absent, so this assertion runs EVERYWHERE.
		const { AnthropicProvider } = await import('../../src/ai/agent/anthropic_provider.ts');
		const saved = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = '';
		try {
			expect(() => new AnthropicProvider()).toThrow(/ANTHROPIC_API_KEY/);
		} finally {
			// assigning undefined leaves the STRING 'undefined' in process.env
			if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = saved;
		}
	});
});

describe('agent loop — RAG tools (2026-07-22 scope/group + passages)', () => {
	// RAG tools require the master switch (semanticSearch/retrievePassages run
	// regardless — the switch gates the API layer, not retrieval — but keep the
	// env honest for any future layering).

	function ragScript(toolName: string, input: Record<string, unknown>): AgentAssistantTurn[] {
		return [
			{
				text: '',
				tool_uses: [{ id: 'toolu_rag', name: toolName, input }],
				stop_reason: 'tool_use',
			},
			{ text: 'RAG ANSWER', tool_uses: [], stop_reason: 'end_turn' },
		];
	}

	function toolResultOf(provider: ScriptedProvider): { content: string; is_error: boolean } {
		const second = provider.seenTranscripts[1] as AgentTranscriptEntry[];
		const resultsEntry = second.find((entry) => entry.role === 'tool_results') as {
			results: { content: string; is_error: boolean }[];
		};
		return resultsEntry.results[0] as { content: string; is_error: boolean };
	}

	test('dedalo_semantic_search forwards scope + group (shape; group-scoped hits are rag:<group>)', async () => {
		const provider = new ScriptedProvider(
			ragScript('dedalo_semantic_search', {
				query: 'guerra en el mundo ibérico',
				section_tipo: 'test3',
				group: 'card',
				limit: 5,
			}),
		);
		const run = await runAgent(SUPERUSER, 'find warfare publications', provider);
		expect(run.stop).toBe('end_turn');
		const result = toolResultOf(provider);
		expect(result.is_error).toBe(false);
		const hits = JSON.parse(result.content) as {
			section_tipo: string;
			component_tipo: string;
		}[];
		expect(Array.isArray(hits)).toBe(true);
		for (const hit of hits) {
			expect(hit.section_tipo).toBe('test3'); // scope pushdown respected
			expect(hit.component_tipo).toBe('rag:card'); // facet respected
		}
	});

	test('dedalo_retrieve_passages clamps, dedupes (section,id,chunk) and carries chunk_index', async () => {
		const provider = new ScriptedProvider(
			ragScript('dedalo_retrieve_passages', {
				query: 'guerra ibérica',
				section_tipo: 'test3',
				limit: 500, // must clamp to 20
			}),
		);
		const run = await runAgent(SUPERUSER, 'ground it', provider);
		expect(run.stop).toBe('end_turn');
		const result = toolResultOf(provider);
		expect(result.is_error).toBe(false);
		const passages = JSON.parse(result.content) as {
			section_tipo: string;
			section_id: number;
			chunk_index: number;
		}[];
		expect(Array.isArray(passages)).toBe(true);
		expect(passages.length).toBeLessThanOrEqual(20);
		const keys = passages.map((p) => `${p.section_tipo}|${p.section_id}|${p.chunk_index}`);
		expect(new Set(keys).size).toBe(keys.length); // per-lang duplicates removed
		for (const passage of passages) {
			expect(typeof passage.chunk_index).toBe('number');
		}
	});

	test('an invalid group slug is treated as ABSENT (no error, api.ts parity)', async () => {
		const provider = new ScriptedProvider(
			ragScript('dedalo_semantic_search', {
				query: 'anything',
				// SCOPED like its siblings. Unscoped, the search fuses whatever the
				// ambient vector store holds — an installation's records, whose
				// section_tipo need not exist in the suite ontology; the ACL gate then
				// throws and the tool result is an error for a reason that has nothing
				// to do with the slug this gate is about.
				section_tipo: 'test3',
				group: 'NOT A SLUG!',
				limit: 2,
			}),
		);
		const run = await runAgent(SUPERUSER, 'q', provider);
		expect(run.stop).toBe('end_turn');
		expect(toolResultOf(provider).is_error).toBe(false);
	});
});

describe('agent loop — a failed RAG tool tells the model a CODE, never the exception’s words (T2 S09-b)', () => {
	// What an exception says is the server's: a driver message, a path, a host.
	// The tool result goes to the model (an EXTERNAL provider's context when one
	// is configured) and into the stored transcript — so it carries what every
	// other failed tool carries: the ONE converter's structured error.
	const SENTINEL = 'SENTINEL-9f3c connect ECONNREFUSED 10.0.0.7:5432 /srv/private/rag.sock';

	for (const tool of ['dedalo_semantic_search', 'dedalo_retrieve_passages'] as const) {
		test(`${tool}: the thrown text never reaches the tool_result, the transcript or the events`, async () => {
			let thrown = 0;
			const boom = async () => {
				thrown += 1;
				throw new Error(SENTINEL);
			};
			mock.module(RETRIEVAL, () => ({
				...REAL_RETRIEVAL,
				semanticSearch: boom,
				retrievePassages: boom,
			}));
			const provider = new ScriptedProvider([
				{
					text: '',
					tool_uses: [
						{ id: 'toolu_boom', name: tool, input: { query: 'x', section_tipo: 'test3' } },
					],
					stop_reason: 'tool_use',
				},
				{ text: 'DONE', tool_uses: [], stop_reason: 'end_turn' },
			]);
			const events: unknown[] = [];
			const quiet = console.error;
			console.error = () => {};
			let run: Awaited<ReturnType<typeof runAgent>>;
			try {
				run = await runAgent(SUPERUSER, 'q', provider, { onEvent: (event) => events.push(event) });
			} finally {
				console.error = quiet;
			}
			// FLOOR: the planted throw is what the tool met.
			expect(thrown).toBe(1);
			const second = provider.seenTranscripts[1] as AgentTranscriptEntry[];
			const entry = second.find((item) => item.role === 'tool_results') as {
				results: { tool_use_id: string; content: string; is_error: boolean }[];
			};
			const result = entry.results[0] as { content: string; is_error: boolean };
			expect(result.is_error).toBe(true);
			// The converter's structured error: a code the model can adapt to.
			const body = JSON.parse(result.content) as { ok: boolean; error: { code: string } };
			expect(body.ok).toBe(false);
			expect(body.error.code).toBe('internal.unexpected');
			// And the words stay home — everywhere the run can be read from.
			for (const surface of [result.content, JSON.stringify(run), JSON.stringify(events)]) {
				expect(surface).not.toContain('SENTINEL');
				expect(surface).not.toContain('ECONNREFUSED');
				expect(surface).not.toContain('/srv/private');
			}
		});
	}
});
